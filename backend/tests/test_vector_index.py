from __future__ import annotations

import json
from typing import Any

from backend import app as app_module


def test_vector_index_requires_fields() -> None:
    client = app_module.app.test_client()

    response = client.post("/api/vector-index", json={})

    assert response.status_code == 400


def test_vector_index_serializes_query(monkeypatch: Any) -> None:
    calls: list[dict[str, Any]] = []

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(payload)
        return {"ok": True}, None

    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/vector-index",
        json={
            "source_database_name": "privacy-compliance",
            "source_collection_name": "policy_chunks",
            "index_database_name": "privacy-compliance",
            "index_collection_name": "policy_embeddings",
            "source_query": {"document_id": "doc-123"},
        },
    )

    assert response.status_code == 200
    assert calls
    forwarded = calls[0]
    assert forwarded["source_collection_name"] == "policy_chunks"
    assert json.loads(forwarded["source_query"]) == {"document_id": "doc-123"}
