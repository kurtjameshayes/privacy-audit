"""Routes for document acquisition: search, crawl, upload, save."""

from __future__ import annotations

import io
import logging
from datetime import datetime, timezone
from typing import Any
import uuid

from flask import Blueprint, jsonify, request

from backend.config import (
    POLICY_COLLECTION,
    POLICY_DATABASE,
    PROXY_URL,
    STATUTE_COLLECTION,
)
from backend.upstream import forward_get, forward_post, forward_delete

try:
    from backend.compliance.engine import load_config as load_compliance_config
    from backend.workflow import upsert_workflow_state
except ImportError:
    from compliance.engine import load_config as load_compliance_config  # type: ignore[no-redef]
    from workflow import upsert_workflow_state  # type: ignore[no-redef]

logger = logging.getLogger(__name__)

bp = Blueprint("gather", __name__)


@bp.route("/api/gather", methods=["POST"])
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


@bp.route("/api/crawl", methods=["POST"])
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


@bp.route("/api/upload-document", methods=["POST"])
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
    except Exception:
        logger.exception("File upload processing failed")
        return jsonify({"error": "Failed to process uploaded file."}), 500


@bp.route("/api/save-policy", methods=["POST"])
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

    return jsonify({
        "message": f"{'Statute' if mode == 'statute' else 'Policy'} saved.",
        "document_id": document_id,
        "data": data,
    })
