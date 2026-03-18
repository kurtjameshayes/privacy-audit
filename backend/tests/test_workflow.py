"""Tests for workflow state and compliance guards."""
from __future__ import annotations

import json
from typing import Any

from backend import app as app_module
from backend import workflow as workflow_module


def test_workflow_state_returns_not_ready_when_missing(monkeypatch: Any) -> None:
    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        return {"documents": []}, None

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    client = app_module.app.test_client()

    response = client.get(
        "/api/documents/doc-123/workflow-state",
        query_string={"document_type": "policy"},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data["document_id"] == "doc-123"
    assert data["document_type"] == "policy"
    assert data["ready_for_compliance"] is False
    assert "gathered" in data["steps"]
    assert data["steps"]["gathered"]["completed"] is False


def test_workflow_state_returns_ready_when_complete(monkeypatch: Any) -> None:
    ready_state = {
        "document_id": "doc-456",
        "document_type": "policy",
        "steps": {
            "gathered": {"completed": True, "completed_at": "2024-01-01T00:00:00Z"},
            "parsed": {"completed": True, "completed_at": "2024-01-01T00:00:00Z"},
            "vector_indexed": {"completed": True, "completed_at": "2024-01-01T00:00:00Z"},
        },
        "ready_for_compliance": True,
    }

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        if "document_workflow_state" in str(params.get("collection_name", "")):
            return {"documents": [ready_state]}, None
        return {"documents": []}, None

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    client = app_module.app.test_client()

    response = client.get(
        "/api/documents/doc-456/workflow-state",
        query_string={"document_type": "policy"},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data["document_id"] == "doc-456"
    assert data["ready_for_compliance"] is True


def test_compliance_returns_409_when_policy_not_ready(monkeypatch: Any) -> None:
    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        if "document_workflow_state" in str(params.get("collection_name", "")):
            return {"documents": []}, None
        return {"documents": [{"_id": "doc-1", "text": "Policy."}]}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        return {"chunks": []}, None

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/compliance/applicability",
        json={"policy_document_id": "doc-1"},
    )

    assert response.status_code == 409
    data = response.get_json()
    assert data.get("error") == "document_not_ready"
    assert "missing_steps" in data


def test_backfill_prefers_document_id_over_mongo_id() -> None:
    writes: list[dict[str, Any]] = []

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        collection = str(params.get("collection_name", ""))
        query_raw = params.get("query")
        query = json.loads(query_raw) if isinstance(query_raw, str) else {}
        if collection == "policies":
            return {
                "documents": [
                    {"_id": "mongo-1", "document_id": "policy-1", "company_name": "Acme"}
                ]
            }, None
        if collection == "statutes":
            return {"documents": []}, None
        if collection == "policy_chunks":
            if query.get("document_id") == "policy-1":
                return {"documents": [{"document_id": "policy-1", "chunk_text": "x"}]}, None
            return {"documents": []}, None
        if collection == "statute_chunks":
            return {"documents": []}, None
        if collection == "document_workflow_state":
            return {"documents": []}, None
        return {"documents": []}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        if endpoint == "/write_to_collection":
            writes.append(payload)
            return {"ok": True}, None
        return {"ok": True}, None

    def fake_forward_delete(endpoint: str, payload: dict[str, Any]) -> Any:
        return {"ok": True}, None

    workflow_module.backfill_workflow_state(
        fake_forward_get,
        fake_forward_post,
        fake_forward_delete,
        database_name="privacy-compliance",
        policy_collection="policies",
        statute_collection="statutes",
        policy_chunk_collection="policy_chunks",
        statute_chunk_collection="statute_chunks",
        policy_index_collection="policy_embeddings",
        statute_index_collection="statute_embeddings",
        workflow_collection="document_workflow_state",
        use_vector_search=False,
    )

    policy_writes = [
        w for w in writes
        if w.get("collection_name") == "document_workflow_state"
        and (w.get("document") or {}).get("document_type") == "policy"
    ]
    assert policy_writes, "expected a policy workflow write"
    written_doc = policy_writes[0]["document"]
    assert written_doc["document_id"] == "policy-1"
    assert written_doc["steps"]["gathered"]["completed"] is True
