from __future__ import annotations

import io
from datetime import datetime, timezone
import json
import os
import uuid
from typing import Any, Tuple

import requests

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
    try:
        response = requests.post(url, json=payload, headers=api_headers(), timeout=60)
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


def forward_get(
    endpoint: str, params: dict[str, Any]
) -> Tuple[Any, Tuple[str, int] | None]:
    if not API_BASE_URL:
        return None, ("GATHER_API_BASE_URL is not set.", 500)
    if not FIRECRAWL_API_KEY:
        return None, ("FIRECRAWL_API_KEY is not set.", 500)

    url = f"{API_BASE_URL.rstrip('/')}/{endpoint.lstrip('/')}"
    try:
        response = requests.get(
            url, params=params, headers=api_headers(), timeout=60
        )
    except requests.RequestException:
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


@app.route("/api/upload-document", methods=["POST"])
def upload_document() -> Any:
    """Accept a file upload (PDF, TXT, HTML) and return extracted text."""
    file = request.files.get("file")
    if not file or not file.filename:
        return jsonify({"error": "No file provided."}), 400

    filename = file.filename.lower()
    mode = str(request.form.get("mode") or "policy").strip()

    try:
        if filename.endswith(".pdf"):
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(file.read()))
            parts = []
            for page in reader.pages:
                text = page.extract_text()
                if text:
                    parts.append(text)
            combined_text = "\n\n".join(parts) if parts else ""
        elif filename.endswith((".txt", ".html", ".htm")):
            raw = file.read()
            try:
                combined_text = raw.decode("utf-8")
            except UnicodeDecodeError:
                combined_text = raw.decode("latin-1", errors="replace")
        else:
            return jsonify({"error": "Unsupported file type. Use PDF, TXT, or HTML."}), 400

        return jsonify({
            "combined_text": combined_text,
            "filename": file.filename,
            "mode": mode,
        })
    except Exception as exc:
        return jsonify({"error": f"Failed to process file: {exc!s}"}), 500


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
        if collection_name == STATUTE_CHUNK_COLLECTION:
            if source_jurisdiction is not None:
                document["jurisdiction"] = source_jurisdiction
            else:
                document.pop("jurisdiction", None)  # do not infer from content

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


def _run_detail_to_compliance_view(doc: dict[str, Any]) -> dict[str, Any]:
    """Transform run detail (drift_check or flat gap format) into user-friendly compliance view."""
    if isinstance(doc.get("gaps"), list) and (
        doc.get("policy_document_id") or doc.get("company_name")
    ):
        pid = doc.get("policy_document_id")
        return {
            "result": doc,
            "request": {"policy_document_id": pid},
            "policy_document_id": pid,
            "run_id": _mongo_id_str(doc.get("_id")),
            "run_at": doc.get("analyzed_at", doc.get("run_at")),
            "status": "completed",
            "job_type": "gap_analysis",
        }
    alerts = doc.get("alerts", [])
    gaps: list[dict[str, Any]] = []
    policy_document_id = ""
    company_name: str | None = None
    jurisdictions: set[str] = set()
    for a in alerts:
        pid = a.get("policy_document_id", "")
        if pid and not policy_document_id:
            policy_document_id = pid
        cn = a.get("company_name")
        if cn is not None and company_name is None:
            company_name = str(cn) if cn else None
        for j in a.get("affected_jurisdictions", []):
            if j:
                jurisdictions.add(str(j))
        for g in a.get("new_gaps", []):
            g = dict(g) if isinstance(g, dict) else {}
            if "status" not in g:
                g["status"] = "missing"
            gaps.append(g)
        for g in a.get("resolved_gaps", []):
            g = dict(g) if isinstance(g, dict) else {}
            g["status"] = "addressed"
            gaps.append(g)
    summary = {
        "addressed": sum(len(a.get("resolved_gaps", [])) for a in alerts),
        "missing": sum(len(a.get("new_gaps", [])) for a in alerts),
        "conflicts": 0,
        "total_requirements": sum(
            len(a.get("new_gaps", [])) + len(a.get("resolved_gaps", []))
            for a in alerts
        ),
    }
    health_score = None
    if alerts:
        health_score = next(
            (a.get("current_score") for a in alerts if a.get("current_score") is not None),
            None
        )
    result = {
        "gaps": gaps,
        "policy_document_id": policy_document_id or None,
        "company_name": company_name,
        "summary": summary,
        "analyzed_at": doc.get("analyzed_at", ""),
        "applicable_jurisdictions": sorted(jurisdictions),
    }
    return {
        "result": result,
        "request": {"policy_document_id": policy_document_id or None},
        "policy_document_id": policy_document_id or None,
        "run_id": _mongo_id_str(doc.get("_id")),
        "run_at": doc.get("analyzed_at", ""),
        "status": "completed",
        "job_type": "regulatory_drift",
        "created_at": doc.get("analyzed_at", ""),
        "completed_at": doc.get("analyzed_at", ""),
        "privacy_health_score": health_score,
    }


def _mongo_id_str(rid: Any) -> str:
    """Convert MongoDB _id to string (handles ObjectId/$oid)."""
    if rid is None:
        return ""
    if isinstance(rid, dict) and "$oid" in rid:
        return str(rid["$oid"])
    return str(rid)


def _fetch_documents(collection: str) -> list[dict[str, Any]]:
    """Fetch all documents from a collection via upstream /documents."""
    params: dict[str, Any] = {
        "database_name": POLICY_DATABASE,
        "collection_name": collection,
    }
    data, error = forward_get("/documents", params)
    if error:
        return []
    if isinstance(data, dict):
        docs = data.get("documents", data.get("data", data.get("results", [])))
        return docs if isinstance(docs, list) else []
    return []


def _runs_from_compliance_run_log(
    limit: int, offset: int,
    policy_document_id: str = "",
    since: str = "",
    until: str = "",
    types: str = "",
) -> dict[str, Any]:
    """Fetch runs from compliance_run_log and compliance_results, merge and return RunsListResponse shape."""
    all_runs: list[dict[str, Any]] = []

    run_log_docs = _fetch_documents(COMPLIANCE_RUN_LOG_COLLECTION)
    for doc in run_log_docs:
        run_id = _mongo_id_str(doc.get("_id"))
        analyzed_at = doc.get("analyzed_at", "")
        alerts = doc.get("alerts", [])
        pid = doc.get("policy_document_id", "")
        company_name = doc.get("company_name")
        first: dict[str, Any] = {}
        if alerts:
            first = next((a for a in alerts if a.get("policy_document_id")), alerts[0])
            pid = pid or first.get("policy_document_id", "")
            company_name = company_name or first.get("company_name")
        all_runs.append({
            "run_id": run_id,
            "job_id": run_id,
            "policy_document_id": pid or "",
            "company_name": company_name,
            "run_at": analyzed_at,
            "created_at": analyzed_at,
            "completed_at": analyzed_at,
            "privacy_health_score": first.get("current_score") if first else None,
            "status": "completed",
            "summary": {
                "addressed": sum(len(a.get("resolved_gaps", [])) for a in alerts),
                "missing": sum(len(a.get("new_gaps", [])) for a in alerts),
                "conflicts": 0,
                "total_requirements": sum(
                    len(a.get("new_gaps", [])) + len(a.get("resolved_gaps", []))
                    for a in alerts
                ),
            },
            "types": ["regulatory_drift"],
            "_source": "compliance_run_log",
            "_doc": doc,
        })

    results_docs = _fetch_documents(COMPLIANCE_RESULTS_COLLECTION)
    for doc in results_docs:
        run_id = _mongo_id_str(doc.get("_id"))
        run_at = doc.get("run_at", "")
        summary = doc.get("summary", {})
        all_runs.append({
            "run_id": run_id,
            "job_id": run_id,
            "policy_document_id": doc.get("policy_document_id", "") or "",
            "company_name": doc.get("company_name"),
            "run_at": run_at,
            "created_at": run_at,
            "completed_at": run_at,
            "privacy_health_score": doc.get("privacy_health_score"),
            "status": "completed",
            "summary": {
                "addressed": summary.get("addressed", 0),
                "missing": summary.get("missing", 0),
                "conflicts": summary.get("conflicts", 0),
                "total_requirements": summary.get("total_requirements", 0),
            },
            "types": ["gap_analysis"],
            "_source": "compliance_results",
            "_doc": doc,
        })

    runs = [{k: v for k, v in r.items() if not k.startswith("_")} for r in all_runs]

    if policy_document_id:
        runs = [r for r in runs if (r.get("policy_document_id") or "") == policy_document_id]
    if since:
        runs = [r for r in runs if (r.get("run_at") or "") >= since]
    if until:
        runs = [r for r in runs if (r.get("run_at") or "") <= until]
    if types:
        want = {t.strip() for t in types.split(",") if t.strip()}
        runs = [r for r in runs if want & set(r.get("types") or [])]

    runs.sort(key=lambda r: r.get("run_at") or "", reverse=True)
    total = len(runs)
    runs = runs[offset : offset + limit]
    return {"runs": runs, "total": total, "limit": limit, "offset": offset}


@app.route("/api/compliance/runs", methods=["GET"])
def compliance_runs() -> Any:
    """Serve runs from compliance_run_log (local MongoDB) for accurate count and list."""
    limit = int(request.args.get("limit", "50") or "50")
    offset = int(request.args.get("offset", "0") or "0")
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    policy_document_id = str(request.args.get("policy_document_id", "")).strip()
    since = str(request.args.get("since", "")).strip()
    until = str(request.args.get("until", "")).strip()
    types = str(request.args.get("types", "")).strip()
    data = _runs_from_compliance_run_log(
        limit=limit, offset=offset,
        policy_document_id=policy_document_id,
        since=since, until=until, types=types,
    )
    return jsonify(data)


@app.route("/api/compliance/runs/<run_id>", methods=["GET", "DELETE"])
def compliance_run_detail(run_id: str) -> Any:
    """Serve run detail from compliance_run_log. DELETE requires upstream support."""
    if request.method == "DELETE":
        data, error = forward_delete(f"/api/compliance/runs/{run_id}", {})
        if error:
            message, status = error
            if status in (404, 405):
                return jsonify({"error": "Delete not supported by upstream."}), 501
            return jsonify({"error": message}), status
        return jsonify(data if data else {"message": "deleted"}), 200

    for collection in (COMPLIANCE_RUN_LOG_COLLECTION, COMPLIANCE_RESULTS_COLLECTION):
        for query in ({"_id": run_id}, {"_id": {"$oid": run_id}}, None):
            params: dict[str, Any] = {
                "database_name": POLICY_DATABASE,
                "collection_name": collection,
            }
            if query is not None:
                params["query"] = json.dumps(query)
            data, error = forward_get("/documents", params)
            if error:
                continue
            docs = []
            if isinstance(data, dict):
                docs = data.get("documents", data.get("data", data.get("results", [])))
            if isinstance(docs, list) and docs:
                if query is None:
                    match = next((d for d in docs if _mongo_id_str(d.get("_id")) == run_id), None)
                    if match:
                        return jsonify(_run_detail_to_compliance_view(match))
                else:
                    return jsonify(_run_detail_to_compliance_view(docs[0]))
    return jsonify({"error": "Run not found."}), 404


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
    save_results = payload.get("save_results", True)
    num_rows = payload.get("num_rows")
    if num_rows is not None:
        try:
            num_rows = int(num_rows)
        except (TypeError, ValueError):
            num_rows = None
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
        save_results=save_results,
        num_rows=num_rows,
    )
    if save_results:
        doc = {**result, "run_at": datetime.now(timezone.utc).isoformat()}
        if "error" in result:
            doc["compliance_error"] = result["error"]
        if "message" in result:
            doc["compliance_message"] = result["message"]
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
    weights = payload.get("weights")
    if isinstance(weights, dict):
        weights = {str(k): float(v) for k, v in weights.items() if isinstance(v, (int, float))}
    else:
        weights = None
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
        weights=weights,
    )
    if payload.get("save_results"):
        doc = {**result, "run_at": datetime.now(timezone.utc).isoformat()}
        if "error" in result:
            doc["compliance_error"] = result["error"]
        if "message" in result:
            doc["compliance_message"] = result["message"]
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


@app.route("/assets/<path:filename>")
def serve_assets(filename: str) -> Any:
    assets_dir = os.path.join(STATIC_FOLDER, "assets")
    return send_from_directory(assets_dir, filename)


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
