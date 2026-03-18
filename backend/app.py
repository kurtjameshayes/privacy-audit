"""Flask application entry point – registers blueprints, serves health/config/static."""

from __future__ import annotations

import json
import os
from typing import Any

import requests

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from backend.config import APP_PROMPTS_FOLDER, API_BASE_URL, STATIC_FOLDER
from backend.upstream import api_headers
from backend.routes.gather import bp as gather_bp
from backend.routes.documents import bp as documents_bp
from backend.routes.compliance import bp as compliance_bp

app = Flask(__name__, static_folder=None)
CORS(app, resources={r"/api/*": {"origins": "*"}})

app.register_blueprint(gather_bp)
app.register_blueprint(documents_bp)
app.register_blueprint(compliance_bp)


# ── Health / config ──────────────────────────────────────────

@app.route("/api/health", methods=["GET"])
def health() -> Any:
    return jsonify({"status": "ok"})


@app.route("/api/upstream-status", methods=["GET"])
def upstream_status() -> Any:
    if not API_BASE_URL:
        return jsonify({"available": False, "error": "GATHER_API_BASE_URL is not set."})
    base = API_BASE_URL.rstrip("/")
    last_error: str | None = None
    for path in ("/health", "/api/health", ""):
        url = f"{base}{path}" if path else base
        try:
            requests.get(url, headers=api_headers(), timeout=10)
            return jsonify({"available": True})
        except requests.RequestException as exc:
            last_error = str(exc) or "Connection failed."
    return jsonify({"available": False, "error": last_error or "Connection failed."})


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


@app.route("/api/config/policy-parse", methods=["GET"])
def get_policy_parse_config() -> Any:
    """Serve policy subsection parse prompt."""
    config_path = os.path.join(APP_PROMPTS_FOLDER, "policy_subsection_parse.json")
    if not os.path.isfile(config_path):
        return jsonify({
            "module": "policy_subsection_parse",
            "parse_prompt": (
                "Segment this privacy policy into sections by these disclosure categories: "
                "right to know, right to delete, sale of data, sensitive data, data portability, "
                "non-discrimination. For each section, provide: (1) chunk_header_text: a short "
                "descriptive title, (2) chunk_text: the section content, (3) category: the matching "
                "disclosure category from the list above (use 'other' if none fit). Output as "
                "structured chunks with these fields."
            ),
            "categories": [
                "right to know",
                "right to delete",
                "sale of data",
                "sensitive data",
                "data portability",
                "non-discrimination",
                "other",
            ],
        })
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        return jsonify(config)
    except (json.JSONDecodeError, IOError) as exc:
        return jsonify({"error": str(exc)}), 500


# ── Static file serving ──────────────────────────────────────

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
