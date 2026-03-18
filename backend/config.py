"""Centralized configuration loaded from environment variables."""

from __future__ import annotations

import os

from dotenv import load_dotenv

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
CONFLICT_RESULTS_COLLECTION = "conflict_results"
COMPLIANCE_ALERTS_COLLECTION = "compliance_alerts"
COMPLIANCE_RUN_LOG_COLLECTION = "compliance_run_log"
COMPLIANCE_JOBS_COLLECTION = "compliance_jobs"
STATUTE_SUB_CHUNK_COLLECTION = "statute_sub_chunks"
POLICY_SUB_CHUNK_COLLECTION = "policy_sub_chunks"
STATUTE_SUB_EMBEDDINGS_COLLECTION = "statute_sub_embeddings"
POLICY_SUB_EMBEDDINGS_COLLECTION = "policy_sub_embeddings"
POLICY_LEGAL_EMBEDDINGS_COLLECTION = "policy_legal_embeddings"

STATIC_FOLDER = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")

ALLOWED_DATABASES = frozenset({POLICY_DATABASE})
ALLOWED_COLLECTIONS = frozenset({
    POLICY_COLLECTION,
    STATUTE_COLLECTION,
    POLICY_CHUNK_COLLECTION,
    STATUTE_CHUNK_COLLECTION,
    COMPLIANCE_RESULTS_COLLECTION,
    CONFLICT_RESULTS_COLLECTION,
    COMPLIANCE_ALERTS_COLLECTION,
    COMPLIANCE_RUN_LOG_COLLECTION,
    COMPLIANCE_JOBS_COLLECTION,
    STATUTE_SUB_CHUNK_COLLECTION,
    POLICY_SUB_CHUNK_COLLECTION,
    STATUTE_SUB_EMBEDDINGS_COLLECTION,
    POLICY_SUB_EMBEDDINGS_COLLECTION,
    POLICY_LEGAL_EMBEDDINGS_COLLECTION,
    "document_workflow_state",
    "companies",
})
