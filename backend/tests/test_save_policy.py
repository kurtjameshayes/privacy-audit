from __future__ import annotations

import uuid
from typing import Any

from backend import app as app_module


def test_save_policy_omits_jurisdiction_for_policy(monkeypatch: Any) -> None:
    calls: list[dict[str, Any]] = []

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(payload)
        return {"ok": True}, None

    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/save-policy",
        json={
            "url": "https://example.com/privacy",
            "combined_text": "Policy text",
            "mode": "policy",
            "jurisdiction": None,
        },
    )

    assert response.status_code == 200
    policy_calls = [c for c in calls if c.get("collection_name") == "policies"]
    assert len(policy_calls) == 1
    document = policy_calls[0]["document"]
    assert "jurisdiction" not in document
    assert "document_id" in document
    uuid.UUID(document["document_id"])
    data = response.get_json()
    assert data.get("document_id") == document["document_id"]


def test_save_policy_includes_jurisdiction_for_statute(monkeypatch: Any) -> None:
    calls: list[dict[str, Any]] = []

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(payload)
        return {"ok": True}, None

    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/save-policy",
        json={
            "url": "https://example.com/statute",
            "combined_text": "Statute text",
            "mode": "statute",
            "jurisdiction": "CA",
        },
    )

    assert response.status_code == 200
    statute_calls = [c for c in calls if c.get("collection_name") == "statutes"]
    assert len(statute_calls) == 1
    document = statute_calls[0]["document"]
    assert document["jurisdiction"] == "CA"
    assert "document_id" in document
    uuid.UUID(document["document_id"])
    data = response.get_json()
    assert data.get("document_id") == document["document_id"]
