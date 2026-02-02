from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from typing import Any, Tuple

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

load_dotenv()

APP_PROMPTS_FOLDER = os.path.join(os.path.dirname(__file__), "..", "app_prompts")

API_BASE_URL = os.getenv("GATHER_API_BASE_URL", "").strip()
FIRECRAWL_API_KEY = os.getenv("FIRECRAWL_API_KEY")
PROXY_URL = os.getenv("PROXY_URL", "").strip()
POLICY_DATABASE = os.getenv("POLICY_DATABASE") or "privacy-compliance"
POLICY_COLLECTION = os.getenv("POLICY_COLLECTION") or "policies"
STATUTE_COLLECTION = os.getenv("STATUTE_COLLECTION") or "statutes"

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
        return None, (str(exc), 502)

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

    document = {
        "source_url": url,
        "title": payload.get("title"),
        "description": payload.get("description"),
        "text": combined_text,
        "query": payload.get("query"),
        "company_name": company_name,
        "pages_crawled": payload.get("pages_crawled"),
        "text_length": payload.get("text_length"),
        "mode": mode,
        "gathered_at": datetime.now(timezone.utc).isoformat(),
    }

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
    return jsonify({"message": message, "data": data})


@app.route("/api/documents", methods=["POST"])
def list_documents() -> Any:
    """Proxy document listing requests to the upstream API."""
    payload = request.get_json(silent=True) or {}
    database_name = str(payload.get("database_name", "")).strip()
    collection_name = str(payload.get("collection_name", "")).strip()

    if not database_name or not collection_name:
        return jsonify({
            "error": "database_name and collection_name are required."
        }), 400

    data, error = forward_post(
        "/documents",
        {
            "database_name": database_name,
            "collection_name": collection_name,
        },
    )
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


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
    app.run(host="0.0.0.0", port=5000, debug=True)
