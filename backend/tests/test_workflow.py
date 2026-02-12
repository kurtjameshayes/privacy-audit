"""Tests for workflow state and compliance guards."""
from __future__ import annotations

from typing import Any

from backend import app as app_module


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
