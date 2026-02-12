from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import uuid
from typing import Any, Tuple

import requests

# #region agent log
DEBUG_LOG_PATH = os.path.join(os.path.dirname(__file__), "..", ".cursor", "debug.log")
def _debug_log(location: str, message: str, data: dict[str, Any], hypothesis_id: str, run_id: str = "run1") -> None:
    try:
        with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps({"id": f"log_{id(f)}", "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000), "location": location, "message": message, "data": data, "runId": run_id, "hypothesisId": hypothesis_id}) + "\n")
    except Exception:
        pass
# #endregion

try:
    from backend.compliance.engine import (
        load_config as load_compliance_config,
        run_applicability,
        run_drift_check,
        run_gap_analysis,
        run_health_score,
        run_multi_jurisdictional,
    )
    from backend.workflow import (
        assert_policy_ready_for_compliance,
        assert_statute_indexed_for_jurisdiction,
        backfill_workflow_state,
        get_workflow_state,
        upsert_workflow_state,
    )
except ImportError:
    from compliance.engine import (
        load_config as load_compliance_config,
        run_applicability,
        run_drift_check,
        run_gap_analysis,
        run_health_score,
        run_multi_jurisdictional,
    )
    from workflow import (
        assert_policy_ready_for_compliance,
        assert_statute_indexed_for_jurisdiction,
        backfill_workflow_state,
        get_workflow_state,
        upsert_workflow_state,
    )
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

# Load .env from project root so GATHER_API_BASE_URL is always from this file (override existing env)
_project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
load_dotenv(os.path.join(_project_root, ".env"), override=True)

APP_PROMPTS_FOLDER = os.path.join(os.path.dirname(__file__), "..", "app_prompts")

API_BASE_URL = os.getenv("GATHER_API_BASE_URL", "").strip()
FIRECRAWL_API_KEY = os.getenv("FIRECRAWL_API_KEY")
PROXY_URL = os.getenv("PROXY_URL", "").strip()
POLICY_DATABASE = os.getenv("POLICY_DATABASE") or "privacy-compliance"
POLICY_COLLECTION = os.getenv("POLICY_COLLECTION") or "policies"
STATUTE_COLLECTION = os.getenv("STATUTE_COLLECTION") or "statutes"
POLICY_CHUNK_COLLECTION = os.getenv("POLICY_CHUNK_COLLECTION") or "policy_chunks"
STATUTE_CHUNK_COLLECTION = os.getenv("STATUTE_CHUNK_COLLECTION") or "statute_chunks"
COMPLIANCE_RESULTS_COLLECTION = "compliance_results"
COMPLIANCE_ALERTS_COLLECTION = "compliance_alerts"
COMPLIANCE_RUN_LOG_COLLECTION = "compliance_run_log"

STATIC_FOLDER = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")

app = Flask(__name__, static_folder=None)
CORS(app, resources={r"/api/*": {"origins": "*"}})


def api_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if FIRECRAWL_API_KEY:
        headers["Authorization"] = f"Bearer {FIRECRAWL_API_KEY}"
    return headers


def forward_post(endpoint: str, payload: dict[str, Any]) -> Tuple[Any, Tuple[str, int] | None]:
    if not API_BASE_URL:
        return None, ("GATHER_API_BASE_URL is not set.", 500)
    if not FIRECRAWL_API_KEY:
        return None, ("FIRECRAWL_API_KEY is not set.", 500)

    url = f"{API_BASE_URL.rstrip('/')}/{endpoint.lstrip('/')}"
    # #region agent log
    _debug_log("app.py:forward_post", "forward_post request", {"url": url, "endpoint": endpoint, "payload_keys": list(payload.keys())}, "H3")
    # #endregion
    try:
        response = requests.post(url, json=payload, headers=api_headers(), timeout=60)
    except requests.RequestException as exc:
        # #region agent log
        _debug_log("app.py:forward_post", "RequestException in forward_post", {"endpoint": endpoint, "exc_type": type(exc).__name__, "exc_message": str(exc), "url": url, "returning_status": 502}, "H2")
        # #endregion
        return None, ("Upstream service unavailable. Check that the service at GATHER_API_BASE_URL is running.", 502)

    if response.status_code >= 400:
        try:
            message = response.json().get("error", response.text)
        except ValueError:
            message = response.text
        return None, (message, response.status_code)

    try:
        return response.json(), None
    except ValueError:
        return {"raw": response.text}, None


def forward_get(
    endpoint: str, params: dict[str, Any]
) -> Tuple[Any, Tuple[str, int] | None]:
    if not API_BASE_URL:
        return None, ("GATHER_API_BASE_URL is not set.", 500)
    if not FIRECRAWL_API_KEY:
        return None, ("FIRECRAWL_API_KEY is not set.", 500)

    url = f"{API_BASE_URL.rstrip('/')}/{endpoint.lstrip('/')}"
    # #region agent log
    _debug_log("app.py:forward_get", "forward_get request", {"url": url, "params": params, "endpoint": endpoint}, "H3")
    # #endregion
    try:
        response = requests.get(
            url, params=params, headers=api_headers(), timeout=60
        )
    except requests.RequestException as exc:
        # #region agent log
        _debug_log("app.py:forward_get", "RequestException in forward_get", {"endpoint": endpoint, "exc_type": type(exc).__name__, "exc_message": str(exc), "url": url, "returning_status": 502}, "H2")
        # #endregion
        return None, ("Upstream service unavailable. Check that the service at GATHER_API_BASE_URL is running.", 502)

    if response.status_code >= 400:
        try:
            message = response.json().get("error", response.text)
        except ValueError:
            message = response.text
        return None, (message, response.status_code)

    try:
        return response.json(), None
    except ValueError:
        return {"raw": response.text}, None


def forward_delete(
    endpoint: str, params: dict[str, Any]
) -> Tuple[Any, Tuple[str, int] | None]:
    if not API_BASE_URL:
        return None, ("GATHER_API_BASE_URL is not set.", 500)
    if not FIRECRAWL_API_KEY:
        return None, ("FIRECRAWL_API_KEY is not set.", 500)

    url = f"{API_BASE_URL.rstrip('/')}/{endpoint.lstrip('/')}"
    try:
        response = requests.delete(
            url, params=params, headers=api_headers(), timeout=60
        )
    except requests.RequestException as exc:
        return None, ("Upstream service unavailable. Check that the service at GATHER_API_BASE_URL is running.", 502)

    if response.status_code >= 400:
        try:
            message = response.json().get("error", response.text)
        except ValueError:
            message = response.text
        return None, (message, response.status_code)

    try:
        return response.json(), None
    except ValueError:
        return {"raw": response.text}, None


@app.route("/api/health", methods=["GET"])
def health() -> Any:
    return jsonify({"status": "ok"})


@app.route("/api/config/privacy-policy-search", methods=["GET"])
def get_privacy_policy_search_config() -> Any:
    config_path = os.path.join(APP_PROMPTS_FOLDER, "privacy_policy_search.json")
    if not os.path.isfile(config_path):
        return jsonify({
            "module": "search_policy",
            "append_prompt": "Privacy Policy full text",
            "prepend_prompt": ""
        })
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        return jsonify(config)
    except (json.JSONDecodeError, IOError) as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/gather", methods=["POST"])
def gather() -> Any:
    payload = request.get_json(silent=True) or {}
    query = str(payload.get("query", "")).strip()
    if not query:
        return jsonify({"error": "Query is required."}), 400

    data, error = forward_post("/gather", {"query": query})
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@app.route("/api/crawl", methods=["POST"])
def crawl() -> Any:
    payload = request.get_json(silent=True) or {}
    url = str(payload.get("url", "")).strip()
    if not url:
        return jsonify({"error": "URL is required."}), 400

    def normalize_int(value: Any, fallback: int) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return fallback
        return max(1, parsed)

    depth = normalize_int(payload.get("depth"), 1)
    breadth = normalize_int(payload.get("breadth"), 1)

    crawl_payload: dict[str, Any] = {
        "url": url,
        "depth": depth,
        "breadth": breadth,
    }
    if PROXY_URL:
        crawl_payload["proxy"] = PROXY_URL

    data, error = forward_post("/crawl", crawl_payload)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@app.route("/api/save-policy", methods=["POST"])
def save_policy() -> Any:
    payload = request.get_json(silent=True) or {}
    url = str(payload.get("url", "")).strip()
    combined_text = str(payload.get("combined_text", "")).strip()

    if not url or not combined_text:
        return jsonify({"error": "URL and combined_text are required."}), 400

    mode = str(payload.get("mode") or "policy").strip()
    collection_name = STATUTE_COLLECTION if mode == "statute" else POLICY_COLLECTION

    company_name = str(payload.get("company_name", "")).strip() or None
    jurisdiction = str(payload.get("jurisdiction", "")).strip() or None
    if mode == "statute" and not jurisdiction:
        return jsonify({"error": "Jurisdiction is required for statutes."}), 400

    document_id = str(uuid.uuid4())
    document = {
        "document_id": document_id,
        "source_url": url,
        "title": payload.get("title"),
        "description": payload.get("description"),
        "text": combined_text,
        "query": payload.get("query"),
        "pages_crawled": payload.get("pages_crawled"),
        "text_length": payload.get("text_length"),
        "mode": mode,
        "gathered_at": datetime.now(timezone.utc).isoformat(),
    }
    if mode == "statute":
        document["jurisdiction"] = jurisdiction
    if mode != "statute":
        document["company_name"] = company_name

    data, error = forward_post(
        "/write_to_collection",
        {
            "database_name": POLICY_DATABASE,
            "collection_name": collection_name,
            "document": document,
            "mode": "append",
        },
    )

    if error:
        message, status = error
        return jsonify({"error": message}), status

    if document_id:
        doc_type = "statute" if mode == "statute" else "policy"
        wf_coll = load_compliance_config().get("workflow_state_collection", "document_workflow_state")
        upsert_workflow_state(
            forward_get,
            forward_post,
            forward_delete,
            POLICY_DATABASE,
            document_id,
            doc_type,
            "gathered",
            wf_coll,
        )

    # Also save to companies collection if company_name is provided
    if company_name:
        company_document = {
            "company_name": company_name,
            "privacy_policy_url": url,
            "added_at": datetime.now(timezone.utc).isoformat(),
        }
        forward_post(
            "/write_to_collection",
            {
                "database_name": POLICY_DATABASE,
                "collection_name": "companies",
                "document": company_document,
                "mode": "append",
            },
        )

    message = f"Saved to {mode} collection."
    if isinstance(data, dict) and data.get("message"):
        message = data["message"]
    response_data = {"message": message, "data": data}
    if document_id:
        response_data["document_id"] = document_id
    return jsonify(response_data)


@app.route("/api/documents", methods=["POST"])
def list_documents() -> Any:
    """Proxy document listing requests to the upstream API."""
    payload = request.get_json(silent=True) or {}
    database_name = str(payload.get("database_name", "")).strip()
    collection_name = str(payload.get("collection_name", "")).strip()
    query = payload.get("query")
    # #region agent log
    _debug_log("app.py:list_documents", "list_documents entry", {"database_name": database_name, "collection_name": collection_name, "API_BASE_URL_set": bool(API_BASE_URL), "API_BASE_URL_host": (API_BASE_URL.split("//")[-1].split("/")[0].split(":")[0] if API_BASE_URL else None), "API_BASE_URL_port": (API_BASE_URL.split(":")[-1].split("/")[0] if API_BASE_URL and ":" in API_BASE_URL.split("//")[-1] else None)}, "H1")
    # #endregion

    if not database_name or not collection_name:
        return jsonify({
            "error": "database_name and collection_name are required."
        }), 400

    params: dict[str, Any] = {
        "database_name": database_name,
        "collection_name": collection_name,
    }
    if query is not None:
        if isinstance(query, (dict, list)):
            params["query"] = json.dumps(query)
        else:
            params["query"] = str(query)

    data, error = forward_get(
        "/documents",
        params,
    )
    if error:
        message, status = error
        # #region agent log
        _debug_log("app.py:list_documents", "forward_get error returned to client", {"status": status, "message_len": len(str(message)), "message_preview": str(message)[:200], "is_connection_error": "Connection refused" in str(message) or "Max retries" in str(message)}, "H2")
        # #endregion
        return jsonify({"error": message}), status
    return jsonify(data)


@app.route("/api/parse-llm", methods=["POST"])
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


@app.route("/api/save-parsed", methods=["POST"])
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

    query = {"document_id": document_id}
    existing, error = forward_get(
        "/documents",
        {
            "database_name": database_name,
            "collection_name": collection_name,
            "query": json.dumps(query),
        },
    )
    if error:
        message, status = error
        return jsonify({"error": message}), status

    existing_documents = []
    if isinstance(existing, dict):
        existing_documents = existing.get("documents", [])
    if existing_documents:
        _, error = forward_delete(
            "/documents",
            {
                "database_name": database_name,
                "collection_name": collection_name,
                "query": json.dumps(query),
            },
        )
        if error:
            message, status = error
            return jsonify({"error": message}), status

    saved_records: list[Any] = []
    for index, chunk in enumerate(chunks):
        if not isinstance(chunk, dict):
            return jsonify({
                "error": f"Chunk at index {index} must be an object."
            }), 400
        chunk_header_text = str(
            chunk.get("parsed_header_text")
            or chunk.get("chunk_header_text")
            or ""
        ).strip()
        chunk_text = str(
            chunk.get("parsed_text") or chunk.get("chunk_text") or ""
        ).strip()
        if not chunk_header_text and not chunk_text:
            return jsonify({
                "error": f"Chunk at index {index} is missing text."
            }), 400

        document = dict(chunk)
        document.pop("_id", None)
        document.pop("parsed_header_text", None)
        document.pop("parsed_text", None)
        document["document_id"] = document_id
        document["chunk_index"] = index
        document["chunk_header_text"] = chunk_header_text
        document["chunk_text"] = chunk_text

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
            message, status = error
            return jsonify({"error": message}), status
        saved_records.append(data)

    wf_coll = load_compliance_config().get("workflow_state_collection", "document_workflow_state")
    doc_type = "statute" if collection_name == "statute_chunks" else "policy"
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

    return jsonify({
        "message": f"Saved {len(saved_records)} parsed sections.",
        "data": saved_records,
    })


@app.route("/api/vector-index", methods=["POST"])
def vector_index() -> Any:
    """Proxy vector index requests to the upstream API."""
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

    data, error = forward_post("/vector-index", proxy_payload)
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


@app.route("/api/vector-search", methods=["POST"])
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


@app.route("/api/workflow/backfill", methods=["POST"])
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


@app.route("/api/documents/<document_id>/workflow-state", methods=["GET"])
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


def _write_compliance_document(collection: str, document: dict[str, Any]) -> None:
    """Persist a document to the compliance results/alerts/run_log collection."""
    forward_post(
        "/write_to_collection",
        {
            "database_name": POLICY_DATABASE,
            "collection_name": collection,
            "document": document,
            "mode": "append",
        },
    )


def _workflow_collection() -> str:
    config = load_compliance_config()
    return config.get("workflow_state_collection", "document_workflow_state")


@app.route("/api/compliance/policy-statute-compliance", methods=["POST"])
def compliance_policy_statute_compliance() -> Any:
    """Proxy policy-statute compliance to the upstream Web Gather API."""
    payload = request.get_json(silent=True) or {}
    policy_id = str(payload.get("policy_id", "")).strip()
    policy_collection = str(payload.get("policy_collection", "")).strip()
    jurisdiction = str(payload.get("jurisdiction", "")).strip()
    if not policy_id:
        return jsonify({"error": "policy_id is required."}), 400
    if not policy_collection:
        return jsonify({"error": "policy_collection is required."}), 400
    if not jurisdiction:
        return jsonify({"error": "jurisdiction is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    body = {
        "policy_id": policy_id,
        "policy_collection": policy_collection,
        "jurisdiction": jurisdiction,
    }
    data, error = forward_post("/api/compliance/policy-statute-compliance", body)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@app.route("/api/compliance/citations", methods=["POST"])
def compliance_citations() -> Any:
    """Proxy statute-policy citation extraction to upstream."""
    payload = request.get_json(silent=True) or {}
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    body = {
        "policy_document_id": policy_document_id,
        "applicable_jurisdictions": payload.get("applicable_jurisdictions"),
    }
    data, error = forward_post("/api/compliance/citations", body)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@app.route("/api/compliance/report", methods=["POST"])
def compliance_report() -> Any:
    """Proxy compliance report generation to upstream."""
    payload = request.get_json(silent=True) or {}
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    format_type = str(payload.get("format", "markdown")).strip() or "markdown"
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    body = {
        "policy_document_id": policy_document_id,
        "format": format_type if format_type in ("markdown", "pdf") else "markdown",
        "source": payload.get("source", "latest_stored"),
        "applicable_jurisdictions": payload.get("applicable_jurisdictions"),
        "include_gap": payload.get("include_gap", True),
        "include_health_score": payload.get("include_health_score", True),
        "include_multi_jurisdictional": payload.get("include_multi_jurisdictional", False),
    }
    data, error = forward_post("/api/compliance/report", body)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@app.route("/api/compliance/risk-assessment", methods=["POST"])
def compliance_risk_assessment() -> Any:
    """Proxy risk assessment to upstream."""
    payload = request.get_json(silent=True) or {}
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    body = {
        "policy_document_id": policy_document_id,
        "applicable_jurisdictions": payload.get("applicable_jurisdictions"),
        "template_id": payload.get("template_id"),
        "include_report": payload.get("include_report", False),
    }
    data, error = forward_post("/api/compliance/risk-assessment", body)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@app.route("/api/compliance/risk-assessment/templates", methods=["GET"])
def compliance_risk_assessment_templates() -> Any:
    """Proxy risk assessment templates list to upstream."""
    data, error = forward_get("/api/compliance/risk-assessment/templates", {})
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@app.route("/api/compliance/alerts", methods=["GET"])
def compliance_alerts() -> Any:
    """Proxy drift alerts list to upstream."""
    params = {
        "policy_document_id": request.args.get("policy_document_id", ""),
        "company_name": request.args.get("company_name", ""),
        "jurisdiction": request.args.get("jurisdiction", ""),
        "since": request.args.get("since", ""),
        "limit": request.args.get("limit", "50"),
        "offset": request.args.get("offset", "0"),
    }
    params = {k: v for k, v in params.items() if v}
    data, error = forward_get("/api/compliance/alerts", params)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@app.route("/api/compliance/runs", methods=["GET"])
def compliance_runs() -> Any:
    """Proxy compliance runs list to upstream."""
    params = {
        "policy_document_id": request.args.get("policy_document_id", ""),
        "since": request.args.get("since", ""),
        "until": request.args.get("until", ""),
        "limit": request.args.get("limit", "50"),
        "offset": request.args.get("offset", "0"),
        "types": request.args.get("types", ""),
    }
    params = {k: v for k, v in params.items() if v}
    data, error = forward_get("/api/compliance/runs", params)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@app.route("/api/compliance/runs/<run_id>", methods=["GET"])
def compliance_run_detail(run_id: str) -> Any:
    """Proxy single compliance run detail to upstream."""
    data, error = forward_get(f"/api/compliance/runs/{run_id}", {})
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@app.route("/api/compliance/applicability", methods=["POST"])
def compliance_applicability() -> Any:
    """Determine applicable jurisdictions for a policy (SLM)."""
    payload = request.get_json(silent=True) or {}
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    config = load_compliance_config()
    result = run_applicability(
        forward_post,
        forward_get,
        POLICY_DATABASE,
        POLICY_COLLECTION,
        POLICY_CHUNK_COLLECTION,
        policy_document_id,
    )
    _debug_log(
        "app.py:compliance_applicability",
        "applicability result",
        {
            "policy_document_id": policy_document_id,
            "applicable_jurisdictions": result.get("applicable_jurisdictions", []),
            "error": result.get("error"),
        },
        "H3",
    )
    return jsonify(result)


@app.route("/api/compliance/gap-analysis", methods=["POST"])
def compliance_gap_analysis() -> Any:
    """Run gap analysis: policy vs statute chunks, return gaps and summary."""
    payload = request.get_json(silent=True) or {}
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    applicable_jurisdictions = payload.get("applicable_jurisdictions")
    if isinstance(applicable_jurisdictions, list):
        applicable_jurisdictions = [str(j) for j in applicable_jurisdictions]
    else:
        applicable_jurisdictions = None
    config = load_compliance_config()
    index_db = payload.get("index_database_name") or config.get("index_database_name")
    index_coll = payload.get("index_collection_name") or config.get("index_collection_name")
    jurisdictions = applicable_jurisdictions or config.get("default_jurisdictions", ["CA", "VA"])
    statute_guard = assert_statute_indexed_for_jurisdiction(
        forward_get,
        forward_post,
        POLICY_DATABASE,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        jurisdictions,
        index_db,
        index_coll,
        _workflow_collection(),
        use_vector_search=config.get("use_vector_search", False),
    )
    if statute_guard:
        return jsonify(statute_guard), 409
    result = run_gap_analysis(
        forward_post,
        forward_get,
        POLICY_DATABASE,
        POLICY_COLLECTION,
        POLICY_CHUNK_COLLECTION,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        policy_document_id,
        applicable_jurisdictions=applicable_jurisdictions,
        config=config,
        index_database_name=index_db,
        index_collection_name=index_coll,
    )
    if payload.get("save_results"):
        doc = {**result, "run_at": datetime.now(timezone.utc).isoformat()}
        _write_compliance_document(COMPLIANCE_RESULTS_COLLECTION, doc)
    return jsonify(result)


@app.route("/api/compliance/multi-jurisdictional", methods=["POST"])
def compliance_multi_jurisdictional() -> Any:
    """Run strictest common denominator and conflict detection."""
    payload = request.get_json(silent=True) or {}
    applicable_jurisdictions = payload.get("applicable_jurisdictions")
    if not applicable_jurisdictions or not isinstance(applicable_jurisdictions, list):
        return jsonify({"error": "applicable_jurisdictions (array) is required."}), 400
    applicable_jurisdictions = [str(j) for j in applicable_jurisdictions]
    policy_document_id = str(payload.get("policy_document_id", "")).strip() or None
    config = load_compliance_config()
    index_db = payload.get("index_database_name") or config.get("index_database_name")
    index_coll = payload.get("index_collection_name") or config.get("index_collection_name")
    statute_guard = assert_statute_indexed_for_jurisdiction(
        forward_get,
        forward_post,
        POLICY_DATABASE,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        applicable_jurisdictions,
        index_db,
        index_coll,
        _workflow_collection(),
        use_vector_search=config.get("use_vector_search", False),
    )
    if statute_guard:
        return jsonify(statute_guard), 409
    if policy_document_id:
        guard_err = assert_policy_ready_for_compliance(
            forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
        )
        if guard_err:
            return jsonify(guard_err), 409
    result = run_multi_jurisdictional(
        forward_post,
        forward_get,
        POLICY_DATABASE,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        applicable_jurisdictions,
        policy_document_id=policy_document_id,
        policy_collection=POLICY_COLLECTION,
        policy_chunk_collection=POLICY_CHUNK_COLLECTION,
        config=config,
        index_database_name=index_db,
        index_collection_name=index_coll,
    )
    return jsonify(result)


@app.route("/api/compliance/health-score", methods=["POST"])
def compliance_health_score() -> Any:
    """Compute Privacy Health Score (0-100) for a policy."""
    payload = request.get_json(silent=True) or {}
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    applicable_jurisdictions = payload.get("applicable_jurisdictions")
    if isinstance(applicable_jurisdictions, list):
        applicable_jurisdictions = [str(j) for j in applicable_jurisdictions]
    else:
        applicable_jurisdictions = None
    config = load_compliance_config()
    index_db = payload.get("index_database_name") or config.get("index_database_name")
    index_coll = payload.get("index_collection_name") or config.get("index_collection_name")
    jurisdictions = applicable_jurisdictions or config.get("default_jurisdictions", ["CA", "VA"])
    statute_guard = assert_statute_indexed_for_jurisdiction(
        forward_get,
        forward_post,
        POLICY_DATABASE,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        jurisdictions,
        index_db,
        index_coll,
        _workflow_collection(),
        use_vector_search=config.get("use_vector_search", False),
    )
    if statute_guard:
        return jsonify(statute_guard), 409
    result = run_health_score(
        forward_post,
        forward_get,
        POLICY_DATABASE,
        POLICY_COLLECTION,
        POLICY_CHUNK_COLLECTION,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        policy_document_id,
        applicable_jurisdictions=applicable_jurisdictions,
        gap_result=None,
        config=config,
        index_database_name=index_db,
        index_collection_name=index_coll,
    )
    if payload.get("save_results"):
        doc = {**result, "run_at": datetime.now(timezone.utc).isoformat()}
        _write_compliance_document(COMPLIANCE_RESULTS_COLLECTION, doc)
    return jsonify(result)


@app.route("/api/compliance/drift-check", methods=["POST"])
def compliance_drift_check() -> Any:
    """Re-run analysis and emit regulatory drift alerts."""
    payload = request.get_json(silent=True) or {}
    since = str(payload.get("since", "")).strip() or None
    policy_document_ids = payload.get("policy_document_ids")
    if isinstance(policy_document_ids, list):
        policy_document_ids = [str(pid) for pid in policy_document_ids]
    else:
        policy_document_ids = None
    if policy_document_ids is None:
        data, err = forward_get(
            "/documents",
            {
                "database_name": POLICY_DATABASE,
                "collection_name": POLICY_COLLECTION,
            },
        )
        if not err and isinstance(data, dict):
            docs = data.get("documents", data.get("data", data.get("results", [])))
            policy_document_ids = [
                str(d.get("_id") or d.get("document_id", ""))
                for d in (docs or [])
                if d.get("_id") or d.get("document_id")
            ]
    not_ready: list[str] = []
    for pid in policy_document_ids or []:
        guard_err = assert_policy_ready_for_compliance(
            forward_get, POLICY_DATABASE, pid, _workflow_collection()
        )
        if guard_err:
            not_ready.append(pid)
    if not_ready:
        return (
            jsonify({
                "error": "document_not_ready",
                "message": "One or more policies must complete gather, parse, and vector index before drift check.",
                "policy_document_ids": not_ready,
            }),
            409,
        )
    config = load_compliance_config()
    index_db = payload.get("index_database_name") or config.get("index_database_name")
    index_coll = payload.get("index_collection_name") or config.get("index_collection_name")

    def write_alert(alert: dict[str, Any]) -> None:
        _write_compliance_document(COMPLIANCE_ALERTS_COLLECTION, alert)

    result = run_drift_check(
        forward_post,
        forward_get,
        POLICY_DATABASE,
        POLICY_COLLECTION,
        POLICY_CHUNK_COLLECTION,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        results_collection=COMPLIANCE_RESULTS_COLLECTION,
        alerts_collection=COMPLIANCE_ALERTS_COLLECTION,
        since=since,
        policy_document_ids=policy_document_ids,
        config=config,
        index_database_name=index_db,
        index_collection_name=index_coll,
        write_alert=write_alert,
    )
    if payload.get("save_run_log"):
        _write_compliance_document(COMPLIANCE_RUN_LOG_COLLECTION, result)
    return jsonify(result)


@app.route("/")
def serve_index() -> Any:
    index_path = os.path.join(STATIC_FOLDER, "index.html")
    if not os.path.isfile(index_path):
        return jsonify({
            "error": "Frontend not built. Run 'npm run build' in the frontend directory.",
            "hint": "The frontend/dist directory does not exist or is missing index.html"
        }), 503
    return send_from_directory(STATIC_FOLDER, "index.html")


@app.errorhandler(404)
def handle_404(error: Any) -> Any:
    if request.path.startswith("/api/"):
        return jsonify({"error": "Not found"}), 404
    index_path = os.path.join(STATIC_FOLDER, "index.html")
    if os.path.isfile(index_path):
        return send_from_directory(STATIC_FOLDER, "index.html")
    return jsonify({
        "error": "Frontend not built. Run 'npm run build' in the frontend directory.",
        "hint": "The frontend/dist directory does not exist or is missing index.html"
    }), 503


@app.errorhandler(405)
def handle_405(error: Any) -> Any:
    if request.path.startswith("/api/"):
        return jsonify({"error": "Method not allowed"}), 405
    return error


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5120, debug=True)
