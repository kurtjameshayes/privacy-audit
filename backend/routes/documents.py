from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from flask import Blueprint, jsonify, request

from backend.config import (
    ALLOWED_COLLECTIONS,
    ALLOWED_DATABASES,
    POLICY_CHUNK_COLLECTION,
    POLICY_COLLECTION,
    POLICY_DATABASE,
    POLICY_LEGAL_EMBEDDINGS_COLLECTION,
    POLICY_SUB_CHUNK_COLLECTION,
    STATUTE_CHUNK_COLLECTION,
    STATUTE_COLLECTION,
    STATUTE_SUB_CHUNK_COLLECTION,
    STATUTE_SUB_EMBEDDINGS_COLLECTION,
)
from backend.upstream import forward_delete, forward_get, forward_post
from backend.utils import strip_dollar_keys

from backend.compliance.engine import load_config as load_compliance_config
from backend.workflow import (
    backfill_workflow_state,
    get_workflow_state,
    upsert_workflow_state,
)

logger = logging.getLogger(__name__)

bp = Blueprint("documents", __name__)


def _run_subsection_pipeline(
    document_id: str,
    document_type: str,
    database_name: str,
) -> tuple[str | None, int | None]:
    """
    Run subsection pipeline: (statute only: create subsections) -> vector-index -> create-vector-index.
    For policies, skip create-policy-subsections and index policy_chunks directly.
    Returns (error_message, status_code) on failure, or (None, None) on success.
    """
    if document_type == "statute":
        subsections_endpoint = "/create-statute-subsections"
        source_collection = STATUTE_CHUNK_COLLECTION
        dest_sub_collection = STATUTE_SUB_CHUNK_COLLECTION
        embeddings_collection = STATUTE_SUB_EMBEDDINGS_COLLECTION
        filter_fields = ["jurisdiction", "document_id"]
        vector_source_collection = dest_sub_collection
        text_column = "subchunk_text"
    else:
        source_collection = POLICY_CHUNK_COLLECTION
        embeddings_collection = POLICY_LEGAL_EMBEDDINGS_COLLECTION
        filter_fields = ["document_id"]
        vector_source_collection = source_collection
        text_column = "chunk_text"

    if document_type == "statute":
        subsections_payload: dict[str, Any] = {
            "column": "chunk_text",
            "database": database_name,
            "destination_collection": dest_sub_collection,
            "parse_prompt": None,
            "source_collection": source_collection,
            "source_query": {"document_id": document_id},
            "subsection_column": "subchunk_text",
        }
        _, err = forward_post(subsections_endpoint, subsections_payload)
        if err:
            msg, status = err
            return msg, status

    source_query = {"document_id": document_id}
    create_embeddings_payload: dict[str, Any] = {
        "source_database_name": database_name,
        "source_collection_name": vector_source_collection,
        "index_database_name": database_name,
        "index_collection_name": embeddings_collection,
        "source_query": json.dumps(source_query),
        "text_column": text_column,
    }
    _, err = forward_post("/create-embeddings", create_embeddings_payload)
    if err:
        msg, status = err
        return msg, status

    create_index_payload: dict[str, Any] = {
        "collection_name": embeddings_collection,
        "database_name": database_name,
        "filter_fields": filter_fields,
        "index_name": "vector_index",
    }
    _, err = forward_post("/create-vector-index", create_index_payload)
    if err:
        msg, status = err
        return msg, status

    return None, None


@bp.route("/api/documents", methods=["POST"])
def list_documents() -> Any:
    """Proxy document listing requests to the upstream API."""
    payload = request.get_json(silent=True) or {}
    database_name = str(payload.get("database_name", "")).strip()
    collection_name = str(payload.get("collection_name", "")).strip()
    logger.info("List documents: db=%s collection=%s", database_name, collection_name)
    query = payload.get("query")

    if not database_name or not collection_name:
        return jsonify({
            "error": "database_name and collection_name are required."
        }), 400

    if database_name not in ALLOWED_DATABASES:
        logger.warning("Blocked request to disallowed database: %s", database_name)
        return jsonify({"error": "Invalid database_name."}), 403
    if collection_name not in ALLOWED_COLLECTIONS:
        logger.warning("Blocked request to disallowed collection: %s", collection_name)
        return jsonify({"error": "Invalid collection_name."}), 403

    params: dict[str, Any] = {
        "database_name": database_name,
        "collection_name": collection_name,
    }
    if query is not None:
        if isinstance(query, dict):
            query = strip_dollar_keys(query)
            params["query"] = json.dumps(query)
        elif isinstance(query, list):
            params["query"] = json.dumps(strip_dollar_keys(query))
        else:
            params["query"] = str(query)

    data, error = forward_get(
        "/documents",
        params,
    )
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/parse-llm", methods=["POST"])
def parse_llm() -> Any:
    """Proxy parsing requests to the upstream API."""
    payload = request.get_json(silent=True) or {}
    database_name = str(payload.get("database_name", "")).strip()
    collection_name = str(payload.get("collection_name", "")).strip()
    document_id = str(payload.get("document_id", "")).strip()
    prompt = str(payload.get("prompt", "")).strip()
    if not database_name or not collection_name or not document_id or not prompt:
        return jsonify({
            "error": "database_name, collection_name, document_id, and prompt are required."
        }), 400

    parse_llm_body = {
        "database": database_name,
        "collection": collection_name,
        "parse_prompt": prompt,
        "database_name": database_name,
        "collection_name": collection_name,
        "document_id": document_id,
        "prompt": prompt,
    }

    data, error = forward_post("/parse-llm", parse_llm_body)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/parse-policy-subsections", methods=["POST"])
def parse_policy_subsections() -> Any:
    """Proxy to upstream /parse-policy-subsections. Same logic as create-policy-subsections but returns subsections in response."""
    payload = request.get_json(silent=True) or {}
    database_name = str(payload.get("database_name", "")).strip() or POLICY_DATABASE
    collection_name = str(payload.get("collection_name", "")).strip()
    document_id = str(payload.get("document_id", "")).strip()
    column = str(payload.get("column", "text")).strip() or "text"
    parse_prompt = str(payload.get("parse_prompt", "")).strip() or None
    if not collection_name or not document_id:
        return jsonify({
            "error": "collection_name and document_id are required."
        }), 400

    body: dict[str, Any] = {
        "database": database_name,
        "collection": collection_name,
        "column": column,
        "source_query": {"document_id": document_id},
    }
    if parse_prompt:
        body["parse_prompt"] = parse_prompt

    data, error = forward_post("/parse-policy-subsections", body)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/save-parsed", methods=["POST"])
def save_parsed_document() -> Any:
    """Persist parsed chunks to the chunk collections."""
    payload = request.get_json(silent=True) or {}
    database_name = str(payload.get("database_name", "")).strip()
    collection_name = str(payload.get("collection_name", "")).strip()
    document_id = str(payload.get("document_id", "")).strip()
    chunks = payload.get("chunks")

    if not database_name or not collection_name or not document_id or not chunks:
        return jsonify({
            "error": "database_name, collection_name, document_id, and chunks are required."
        }), 400
    if not isinstance(chunks, list):
        return jsonify({"error": "chunks must be a list."}), 400

    logger.info("save_parsed: doc_id=%s collection=%s chunks=%d", document_id, collection_name, len(chunks))

    source_jurisdiction: str | None = None
    if collection_name == STATUTE_CHUNK_COLLECTION:
        statute_res, statute_err = forward_get(
            "/documents",
            {
                "database_name": database_name,
                "collection_name": STATUTE_COLLECTION,
                "query": json.dumps({"document_id": document_id}),
            },
        )
        if not statute_err and isinstance(statute_res, dict):
            docs = statute_res.get("documents", statute_res.get("data", statute_res.get("results", [])))
            if isinstance(docs, list) and docs:
                source_jurisdiction = str(docs[0].get("jurisdiction", "") or "").strip() or None

    staging_id = f"staging-{uuid.uuid4()}"

    def _single_line(s: str) -> str:
        return " ".join(s.split())

    staged_records: list[Any] = []
    for index, chunk in enumerate(chunks):
        if not isinstance(chunk, dict):
            return jsonify({
                "error": f"Chunk at index {index} must be an object."
            }), 400

        chunk_header_text = _single_line(
            str(
                chunk.get("parsed_header_text")
                or chunk.get("chunk_header_text")
                or ""
            )
        )
        chunk_text = _single_line(
            str(chunk.get("parsed_text") or chunk.get("chunk_text") or "")
        )
        if not chunk_header_text and not chunk_text:
            return jsonify({
                "error": f"Chunk at index {index} is missing text."
            }), 400

        document = dict(chunk)
        document.pop("_id", None)
        document.pop("parsed_header_text", None)
        document.pop("parsed_text", None)
        document["document_id"] = staging_id
        document["chunk_index"] = index
        document["chunk_header_text"] = chunk_header_text
        document["chunk_text"] = chunk_text
        if collection_name == STATUTE_CHUNK_COLLECTION:
            if source_jurisdiction is not None:
                document["jurisdiction"] = source_jurisdiction
            else:
                document.pop("jurisdiction", None)

        data, error = forward_post(
            "/write_to_collection",
            {
                "database_name": database_name,
                "collection_name": collection_name,
                "document": document,
                "mode": "append",
            },
        )
        if error:
            forward_delete(
                "/documents",
                {
                    "database_name": database_name,
                    "collection_name": collection_name,
                    "query": json.dumps({"document_id": staging_id}),
                },
            )
            message, status = error
            return jsonify({"error": message}), status
        staged_records.append(data)

    forward_delete(
        "/documents",
        {
            "database_name": database_name,
            "collection_name": collection_name,
            "query": json.dumps({"document_id": document_id}),
        },
    )

    for rec in staged_records:
        if isinstance(rec, dict) and rec.get("document_id") == staging_id:
            rec["document_id"] = document_id

    _, update_err = forward_post(
        "/update_documents",
        {
            "database_name": database_name,
            "collection_name": collection_name,
            "query": {"document_id": staging_id},
            "update": {"$set": {"document_id": document_id}},
        },
    )
    if update_err:
        update_msg, update_status = update_err
        logger.error("save_parsed: staging promote failed for doc_id=%s: %s", document_id, update_msg)
        return jsonify({"error": f"Failed to finalize parsed chunks: {update_msg}"}), update_status or 500

    saved_records = staged_records

    wf_coll = load_compliance_config().get("workflow_state_collection", "document_workflow_state")
    doc_type = "statute" if collection_name == STATUTE_CHUNK_COLLECTION else "policy"
    upsert_workflow_state(
        forward_get,
        forward_post,
        forward_delete,
        database_name,
        document_id,
        doc_type,
        "parsed",
        wf_coll,
    )

    err_msg, err_status = _run_subsection_pipeline(document_id, doc_type, database_name)
    if err_msg is not None:
        return jsonify({"error": err_msg}), err_status or 500

    upsert_workflow_state(
        forward_get,
        forward_post,
        forward_delete,
        database_name,
        document_id,
        doc_type,
        "vector_indexed",
        wf_coll,
    )

    return jsonify({
        "message": f"Saved {len(saved_records)} parsed sections.",
        "data": saved_records,
    })


@bp.route("/api/vector-index", methods=["POST"])
def vector_index() -> Any:
    """Proxy vector index requests to upstream /create-embeddings."""
    payload = request.get_json(silent=True) or {}
    source_database_name = str(payload.get("source_database_name", "")).strip()
    source_collection_name = str(payload.get("source_collection_name", "")).strip()
    index_database_name = str(payload.get("index_database_name", "")).strip()
    index_collection_name = str(payload.get("index_collection_name", "")).strip()
    source_query = payload.get("source_query")

    if (
        not source_database_name
        or not source_collection_name
        or not index_database_name
        or not index_collection_name
    ):
        return jsonify({
            "error": (
                "source_database_name, source_collection_name, index_database_name, "
                "and index_collection_name are required."
            )
        }), 400

    proxy_payload: dict[str, Any] = {
        "source_database_name": source_database_name,
        "source_collection_name": source_collection_name,
        "index_database_name": index_database_name,
        "index_collection_name": index_collection_name,
    }
    if source_query is not None:
        if isinstance(source_query, (dict, list)):
            proxy_payload["source_query"] = json.dumps(source_query)
        else:
            proxy_payload["source_query"] = str(source_query)
    if payload.get("text_column"):
        proxy_payload["text_column"] = str(payload["text_column"])

    data, error = forward_post("/create-embeddings", proxy_payload)
    if error:
        message, status = error
        return jsonify({"error": message}), status

    document_ids = payload.get("document_ids")
    if document_ids and isinstance(document_ids, list):
        wf_coll = load_compliance_config().get("workflow_state_collection", "document_workflow_state")
        doc_type = "statute" if "statute" in source_collection_name.lower() else "policy"
        for doc_id in document_ids:
            if doc_id:
                upsert_workflow_state(
                    forward_get,
                    forward_post,
                    forward_delete,
                    source_database_name,
                    str(doc_id),
                    doc_type,
                    "vector_indexed",
                    wf_coll,
                )
    else:
        sq = source_query
        if isinstance(sq, str):
            try:
                sq = json.loads(sq)
            except (json.JSONDecodeError, TypeError):
                sq = None
        if sq and isinstance(sq, dict) and sq.get("document_id"):
            doc_id = str(sq["document_id"])
            wf_coll = load_compliance_config().get("workflow_state_collection", "document_workflow_state")
            doc_type = "statute" if "statute" in source_collection_name.lower() else "policy"
            upsert_workflow_state(
                forward_get,
                forward_post,
                forward_delete,
                source_database_name,
                doc_id,
                doc_type,
                "vector_indexed",
                wf_coll,
            )

    return jsonify(data)


@bp.route("/api/create-statute-subsections", methods=["POST"])
def create_statute_subsections() -> Any:
    """Proxy create-statute-subsections to upstream. Creates statute_sub_chunks from statute_chunks."""
    payload = request.get_json(silent=True) or {}
    document_id = str(payload.get("document_id", "")).strip()
    database_name = str(payload.get("database_name", "")).strip() or POLICY_DATABASE
    if not document_id:
        return jsonify({"error": "document_id is required."}), 400
    proxy_payload: dict[str, Any] = {
        "column": "chunk_text",
        "database": database_name,
        "destination_collection": STATUTE_SUB_CHUNK_COLLECTION,
        "parse_prompt": None,
        "source_collection": STATUTE_CHUNK_COLLECTION,
        "source_query": {"document_id": document_id},
        "subsection_column": "subchunk_text",
    }
    data, error = forward_post("/create-statute-subsections", proxy_payload)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/create-policy-subsections", methods=["POST"])
def create_policy_subsections() -> Any:
    """Proxy create-policy-subsections to upstream. Creates policy_sub_chunks from policy_chunks."""
    payload = request.get_json(silent=True) or {}
    document_id = str(payload.get("document_id", "")).strip()
    database_name = str(payload.get("database_name", "")).strip() or POLICY_DATABASE
    if not document_id:
        return jsonify({"error": "document_id is required."}), 400
    proxy_payload: dict[str, Any] = {
        "column": "chunk_text",
        "database": database_name,
        "destination_collection": POLICY_SUB_CHUNK_COLLECTION,
        "parse_prompt": None,
        "source_collection": POLICY_CHUNK_COLLECTION,
        "source_query": {"document_id": document_id},
        "subsection_column": "subchunk_text",
    }
    data, error = forward_post("/create-policy-subsections", proxy_payload)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/create-vector-index", methods=["POST"])
def create_vector_index() -> Any:
    """Proxy create-vector-index to upstream. Creates Atlas/vector index on embeddings collection."""
    payload = request.get_json(silent=True) or {}
    collection_name = str(payload.get("collection_name", "")).strip()
    database_name = str(payload.get("database_name", "")).strip() or POLICY_DATABASE
    filter_fields = payload.get("filter_fields")
    index_name = str(payload.get("index_name", "")).strip() or "vector_index"
    if not collection_name:
        return jsonify({"error": "collection_name is required."}), 400
    proxy_payload: dict[str, Any] = {
        "collection_name": collection_name,
        "database_name": database_name,
        "filter_fields": filter_fields if isinstance(filter_fields, list) else [],
        "index_name": index_name,
    }
    data, error = forward_post("/create-vector-index", proxy_payload)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/run-subsection-pipeline", methods=["POST"])
def run_subsection_pipeline() -> Any:
    """
    Run the subsection pipeline: create subsections -> vector-index -> create-vector-index.
    Requires chunks to already exist for the document. On success, upserts vector_indexed.
    """
    payload = request.get_json(silent=True) or {}
    document_id = str(payload.get("document_id", "")).strip()
    database_name = str(payload.get("database_name", "")).strip() or POLICY_DATABASE
    doc_type = "statute" if payload.get("mode") == "statute" else "policy"
    if not document_id:
        return jsonify({"error": "document_id is required."}), 400
    err_msg, err_status = _run_subsection_pipeline(document_id, doc_type, database_name)
    if err_msg is not None:
        return jsonify({"error": err_msg}), err_status or 500
    wf_coll = load_compliance_config().get("workflow_state_collection", "document_workflow_state")
    upsert_workflow_state(
        forward_get,
        forward_post,
        forward_delete,
        database_name,
        document_id,
        doc_type,
        "vector_indexed",
        wf_coll,
    )
    return jsonify({"message": "Subsections and vector index created."})


@bp.route("/api/vector-search", methods=["POST"])
def vector_search() -> Any:
    """Proxy vector search requests to the upstream API (query embedding, filter by metadata, return top-k chunks)."""
    payload = request.get_json(silent=True) or {}
    index_database_name = str(payload.get("index_database_name", "")).strip()
    index_collection_name = str(payload.get("index_collection_name", "")).strip()
    query_text = payload.get("query_text")
    query_embedding = payload.get("query_embedding")
    if not index_database_name or not index_collection_name:
        return jsonify({
            "error": "index_database_name and index_collection_name are required."
        }), 400
    if query_text is None and query_embedding is None:
        return jsonify({"error": "query_text or query_embedding is required."}), 400

    proxy_payload: dict[str, Any] = {
        "index_database_name": index_database_name,
        "index_collection_name": index_collection_name,
    }
    if query_text is not None:
        proxy_payload["query_text"] = query_text
    if query_embedding is not None:
        proxy_payload["query_embedding"] = query_embedding
    if "filter" in payload:
        f = payload["filter"]
        if isinstance(f, (dict, list)):
            proxy_payload["filter"] = json.dumps(f) if isinstance(f, dict) else f
        else:
            proxy_payload["filter"] = f
    if "top_k" in payload:
        proxy_payload["top_k"] = int(payload["top_k"]) if payload["top_k"] is not None else 20

    data, error = forward_post("/vector-search", proxy_payload)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/workflow/backfill", methods=["POST"])
def workflow_backfill() -> Any:
    """Backfill workflow state for existing policies and statutes."""
    config = load_compliance_config()
    result = backfill_workflow_state(
        forward_get,
        forward_post,
        forward_delete,
        POLICY_DATABASE,
        POLICY_COLLECTION,
        STATUTE_COLLECTION,
        POLICY_CHUNK_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        config.get("policy_index_collection_name", "policy_embeddings"),
        config.get("index_collection_name", "statute_embeddings"),
        config.get("workflow_state_collection", "document_workflow_state"),
        use_vector_search=config.get("use_vector_search", False),
    )
    return jsonify(result)


@bp.route("/api/documents/<document_id>/workflow-state", methods=["GET"])
def get_document_workflow_state(document_id: str) -> Any:
    """Get workflow state for a document. Query param: document_type=policy|statute."""
    document_type = request.args.get("document_type", "policy").strip()
    if document_type not in ("policy", "statute"):
        return jsonify({"error": "document_type must be policy or statute"}), 400
    wf_coll = load_compliance_config().get("workflow_state_collection", "document_workflow_state")
    state = get_workflow_state(
        forward_get,
        POLICY_DATABASE,
        document_id,
        document_type,
        wf_coll,
    )
    if not state:
        return jsonify({
            "document_id": document_id,
            "document_type": document_type,
            "steps": {
                "gathered": {"completed": False, "completed_at": None},
                "parsed": {"completed": False, "completed_at": None},
                "vector_indexed": {"completed": False, "completed_at": None},
            },
            "ready_for_compliance": False,
        })
    return jsonify(state)


_DEFAULT_WORKFLOW_STATE = {
    "gathered": {"completed": False, "completed_at": None},
    "parsed": {"completed": False, "completed_at": None},
    "vector_indexed": {"completed": False, "completed_at": None},
}


@bp.route("/api/documents/workflow-states", methods=["POST"])
def get_batch_workflow_states() -> Any:
    """Return workflow states for multiple documents in a single call."""
    payload = request.get_json(silent=True) or {}
    document_ids = payload.get("document_ids", [])
    document_type = str(payload.get("document_type", "policy")).strip()
    if document_type not in ("policy", "statute"):
        return jsonify({"error": "document_type must be policy or statute"}), 400
    if not isinstance(document_ids, list) or not document_ids:
        return jsonify({"error": "document_ids (non-empty array) is required."}), 400

    wf_coll = load_compliance_config().get("workflow_state_collection", "document_workflow_state")
    params: dict[str, Any] = {
        "database_name": POLICY_DATABASE,
        "collection_name": wf_coll,
        "query": json.dumps({"document_type": document_type}),
    }
    data, error = forward_get("/documents", params)
    all_states: list[dict[str, Any]] = []
    if not error and isinstance(data, dict):
        all_states = data.get("documents", data.get("data", data.get("results", [])))

    state_by_id: dict[str, dict[str, Any]] = {}
    for s in all_states:
        did = s.get("document_id", "")
        if did:
            state_by_id[did] = s

    results: dict[str, dict[str, Any]] = {}
    for did in document_ids:
        did = str(did).strip()
        if did in state_by_id:
            results[did] = state_by_id[did]
        else:
            results[did] = {
                "document_id": did,
                "document_type": document_type,
                "steps": dict(_DEFAULT_WORKFLOW_STATE),
                "ready_for_compliance": False,
            }
    return jsonify({"states": results})
