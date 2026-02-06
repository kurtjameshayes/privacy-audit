from __future__ import annotations

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
    assert len(calls) == 1
    document = calls[0]["document"]
    assert "jurisdiction" not in document


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
    assert len(calls) == 1
    document = calls[0]["document"]
    assert document["jurisdiction"] == "CA"
