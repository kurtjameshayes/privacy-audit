"""Tests for create-statute-subsections, create-policy-subsections, create-vector-index, run-subsection-pipeline."""

from __future__ import annotations

from typing import Any

from backend import app as app_module
from backend.routes import documents as docs_module


def test_create_statute_subsections_requires_document_id() -> None:
    client = app_module.app.test_client()
    response = client.post("/api/create-statute-subsections", json={})
    assert response.status_code == 400
    assert "document_id" in (response.get_json() or {}).get("error", "").lower()


def test_create_statute_subsections_forwards_payload(monkeypatch: Any) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append((endpoint, payload))
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/create-statute-subsections",
        json={"document_id": "stat-doc-1", "database_name": "privacy-compliance"},
    )

    assert response.status_code == 200
    assert len(calls) == 1
    endpoint, payload = calls[0]
    assert endpoint == "/create-statute-subsections"
    assert payload["source_collection"] == "statute_chunks"
    assert payload["destination_collection"] == "statute_sub_chunks"
    assert payload["source_query"] == {"document_id": "stat-doc-1"}
    assert payload["subsection_column"] == "subchunk_text"


def test_create_policy_subsections_requires_document_id() -> None:
    client = app_module.app.test_client()
    response = client.post("/api/create-policy-subsections", json={})
    assert response.status_code == 400
    assert "document_id" in (response.get_json() or {}).get("error", "").lower()


def test_create_policy_subsections_forwards_payload(monkeypatch: Any) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append((endpoint, payload))
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/create-policy-subsections",
        json={"document_id": "policy-doc-1"},
    )

    assert response.status_code == 200
    assert len(calls) == 1
    endpoint, payload = calls[0]
    assert endpoint == "/create-policy-subsections"
    assert payload["source_collection"] == "policy_chunks"
    assert payload["destination_collection"] == "policy_sub_chunks"
    assert payload["source_query"] == {"document_id": "policy-doc-1"}


def test_create_vector_index_requires_collection_name() -> None:
    client = app_module.app.test_client()
    response = client.post("/api/create-vector-index", json={})
    assert response.status_code == 400
    assert "collection_name" in (response.get_json() or {}).get("error", "").lower()


def test_create_vector_index_forwards_payload(monkeypatch: Any) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append((endpoint, payload))
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/create-vector-index",
        json={
            "collection_name": "statute_sub_embeddings",
            "database_name": "privacy-compliance",
            "filter_fields": ["jurisdiction", "document_id"],
            "index_name": "vector_index",
        },
    )

    assert response.status_code == 200
    assert len(calls) == 1
    endpoint, payload = calls[0]
    assert endpoint == "/create-vector-index"
    assert payload["collection_name"] == "statute_sub_embeddings"
    assert payload["filter_fields"] == ["jurisdiction", "document_id"]
    assert payload["index_name"] == "vector_index"


def test_run_subsection_pipeline_requires_document_id() -> None:
    client = app_module.app.test_client()
    response = client.post("/api/run-subsection-pipeline", json={})
    assert response.status_code == 400
    assert "document_id" in (response.get_json() or {}).get("error", "").lower()


def test_run_subsection_pipeline_runs_full_workflow(monkeypatch: Any) -> None:
    """run-subsection-pipeline runs create-subsections, vector-index, create-vector-index and upserts vector_indexed."""
    post_calls: list[tuple[str, dict[str, Any]]] = []

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        return {"documents": []}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        post_calls.append((endpoint, payload))
        return {"ok": True}, None

    def fake_forward_delete(endpoint: str, params: dict[str, Any]) -> Any:
        return None, None

    monkeypatch.setattr(docs_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
    monkeypatch.setattr(docs_module, "forward_delete", fake_forward_delete)
    client = app_module.app.test_client()

    response = client.post(
        "/api/run-subsection-pipeline",
        json={
            "database_name": "privacy-compliance",
            "document_id": "doc-ccpa",
            "mode": "statute",
        },
    )

    assert response.status_code == 200
    endpoints = [e for e, _ in post_calls]
    assert "/create-statute-subsections" in endpoints
    assert "/create-embeddings" in endpoints
    assert "/create-vector-index" in endpoints
    vi_call = next((p for e, p in post_calls if e == "/create-embeddings"), None)
    assert vi_call is not None
    assert vi_call.get("text_column") == "subchunk_text"
    assert vi_call.get("source_collection_name") == "statute_sub_chunks"
