from __future__ import annotations

import json
from typing import Any

from backend import app as app_module
from backend.routes import documents as docs_module


def test_vector_index_requires_fields() -> None:
    client = app_module.app.test_client()

    response = client.post("/api/vector-index", json={})

    assert response.status_code == 400


def test_vector_index_serializes_query(monkeypatch: Any) -> None:
    post_calls: list[tuple[str, dict[str, Any]]] = []

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        post_calls.append((endpoint, payload))
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
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
    assert post_calls
    endpoint, forwarded = post_calls[0]
    assert endpoint == "/create-embeddings"
    assert forwarded["source_collection_name"] == "policy_chunks"
    assert json.loads(forwarded["source_query"]) == {"document_id": "doc-123"}


def test_vector_index_passes_text_column(monkeypatch: Any) -> None:
    post_calls: list[tuple[str, dict[str, Any]]] = []

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        post_calls.append((endpoint, payload))
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/vector-index",
        json={
            "source_database_name": "privacy-compliance",
            "source_collection_name": "statute_sub_chunks",
            "index_database_name": "privacy-compliance",
            "index_collection_name": "statute_sub_embeddings",
            "source_query": {"document_id": "doc-456"},
            "text_column": "subchunk_text",
        },
    )

    assert response.status_code == 200
    assert post_calls
    _, forwarded = post_calls[0]
    assert forwarded["text_column"] == "subchunk_text"
