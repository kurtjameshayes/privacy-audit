"""Integration tests for documents routes: list, batch workflow, save-parsed staging, NoSQL guard."""
from __future__ import annotations

import json
from typing import Any

import pytest

from backend import app as app_module
from backend.routes import documents as docs_module


@pytest.fixture()
def client():
    app_module.app.config["TESTING"] = True
    with app_module.app.test_client() as c:
        yield c


# ── list_documents ────────────────────────────────────────────

class TestListDocuments:
    def test_requires_db_and_collection(self, client):
        resp = client.post("/api/documents", json={})
        assert resp.status_code == 400

    def test_rejects_disallowed_database(self, client):
        resp = client.post(
            "/api/documents",
            json={"database_name": "admin", "collection_name": "policies"},
        )
        assert resp.status_code == 403

    def test_rejects_disallowed_collection(self, client):
        resp = client.post(
            "/api/documents",
            json={"database_name": "privacy-compliance", "collection_name": "secret_stuff"},
        )
        assert resp.status_code == 403

    def test_valid_request_forwards(self, client, monkeypatch):
        def fake_get(endpoint, params):
            return {"documents": [{"_id": "1"}]}, None

        monkeypatch.setattr(docs_module, "forward_get", fake_get)

        resp = client.post(
            "/api/documents",
            json={"database_name": "privacy-compliance", "collection_name": "policies"},
        )
        assert resp.status_code == 200


# ── NoSQL injection protection ────────────────────────────────

class TestNoSQLInjectionProtection:
    def test_strips_top_level_dollar_keys(self, client, monkeypatch):
        captured: list[dict] = []

        def fake_get(endpoint, params):
            captured.append(params)
            return {"documents": []}, None

        monkeypatch.setattr(docs_module, "forward_get", fake_get)

        resp = client.post(
            "/api/documents",
            json={
                "database_name": "privacy-compliance",
                "collection_name": "policies",
                "query": {"company_name": "Acme", "$ne": "admin"},
            },
        )
        assert resp.status_code == 200
        query_str = captured[0].get("query", "{}")
        parsed = json.loads(query_str)
        assert "$ne" not in parsed
        assert "company_name" in parsed

    def test_strips_nested_dollar_keys(self, client, monkeypatch):
        captured: list[dict] = []

        def fake_get(endpoint, params):
            captured.append(params)
            return {"documents": []}, None

        monkeypatch.setattr(docs_module, "forward_get", fake_get)

        resp = client.post(
            "/api/documents",
            json={
                "database_name": "privacy-compliance",
                "collection_name": "policies",
                "query": {"status": {"$gt": 0, "value": "active"}},
            },
        )
        assert resp.status_code == 200
        query_str = captured[0].get("query", "{}")
        parsed = json.loads(query_str)
        assert "$gt" not in parsed.get("status", {})
        assert parsed["status"]["value"] == "active"


# ── batch workflow states ─────────────────────────────────────

class TestBatchWorkflowStates:
    def test_requires_document_ids(self, client):
        resp = client.post(
            "/api/documents/workflow-states",
            json={"document_type": "policy"},
        )
        assert resp.status_code == 400

    def test_rejects_invalid_document_type(self, client):
        resp = client.post(
            "/api/documents/workflow-states",
            json={"document_ids": ["d1"], "document_type": "unknown"},
        )
        assert resp.status_code == 400

    def test_returns_states_for_found_docs(self, client, monkeypatch):
        states = [
            {
                "document_id": "d1",
                "document_type": "policy",
                "steps": {
                    "gathered": {"completed": True, "completed_at": "t"},
                    "parsed": {"completed": True, "completed_at": "t"},
                    "vector_indexed": {"completed": True, "completed_at": "t"},
                },
                "ready_for_compliance": True,
            }
        ]

        def fake_get(endpoint, params):
            return {"documents": states}, None

        monkeypatch.setattr(docs_module, "forward_get", fake_get)

        resp = client.post(
            "/api/documents/workflow-states",
            json={"document_ids": ["d1", "d2"], "document_type": "policy"},
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert "d1" in data["states"]
        assert data["states"]["d1"]["ready_for_compliance"] is True
        assert "d2" in data["states"]
        assert data["states"]["d2"]["ready_for_compliance"] is False

    def test_returns_defaults_for_missing_docs(self, client, monkeypatch):
        def fake_get(endpoint, params):
            return {"documents": []}, None

        monkeypatch.setattr(docs_module, "forward_get", fake_get)

        resp = client.post(
            "/api/documents/workflow-states",
            json={"document_ids": ["x1"], "document_type": "statute"},
        )
        assert resp.status_code == 200
        state = resp.get_json()["states"]["x1"]
        assert state["document_type"] == "statute"
        assert state["ready_for_compliance"] is False
        assert state["steps"]["gathered"]["completed"] is False


# ── save_parsed staging check ─────────────────────────────────

class TestSaveParsedStagingCheck:
    def test_returns_error_when_staging_promote_fails(self, client, monkeypatch):
        """Promote needs staged rows from GET /documents; empty result fails finalize."""

        def fake_get(endpoint, params):
            return {"documents": []}, None

        def fake_post(endpoint, payload):
            return {"ok": True}, None

        def fake_delete(endpoint, params):
            return None, None

        monkeypatch.setattr(docs_module, "forward_get", fake_get)
        monkeypatch.setattr(docs_module, "forward_post", fake_post)
        monkeypatch.setattr(docs_module, "forward_delete", fake_delete)

        resp = client.post(
            "/api/save-parsed",
            json={
                "database_name": "privacy-compliance",
                "collection_name": "policy_chunks",
                "document_id": "doc-1",
                "chunks": [{"chunk_header_text": "H", "chunk_text": "T"}],
            },
        )

        assert resp.status_code == 500
        err = resp.get_json()["error"].lower()
        assert "finalize" in err or "staged" in err


# ── single workflow state endpoint ────────────────────────────

class TestSingleWorkflowState:
    def test_returns_not_ready_default(self, client, monkeypatch):
        def fake_get(endpoint, params):
            return {"documents": []}, None

        monkeypatch.setattr(docs_module, "forward_get", fake_get)

        resp = client.get(
            "/api/documents/doc-1/workflow-state",
            query_string={"document_type": "policy"},
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["ready_for_compliance"] is False

    def test_rejects_invalid_document_type(self, client):
        resp = client.get(
            "/api/documents/doc-1/workflow-state",
            query_string={"document_type": "invalid"},
        )
        assert resp.status_code == 400


# ── workflow backfill ─────────────────────────────────────────

class TestWorkflowBackfill:
    def test_backfill_returns_counts(self, client, monkeypatch):
        def fake_get(endpoint, params):
            collection = params.get("collection_name", "")
            if collection == "policies":
                return {"documents": [{"document_id": "p1"}]}, None
            if collection == "policy_chunks":
                return {"documents": [{"document_id": "p1", "chunk_text": "x"}]}, None
            return {"documents": []}, None

        def fake_post(endpoint, payload):
            return {"ok": True}, None

        def fake_delete(endpoint, params):
            return None, None

        monkeypatch.setattr(docs_module, "forward_get", fake_get)
        monkeypatch.setattr(docs_module, "forward_post", fake_post)
        monkeypatch.setattr(docs_module, "forward_delete", fake_delete)

        resp = client.post("/api/workflow/backfill", json={})
        assert resp.status_code == 200
        data = resp.get_json()
        assert "policies" in data
        assert "statutes" in data
