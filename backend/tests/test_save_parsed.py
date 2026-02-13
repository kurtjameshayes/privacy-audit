from __future__ import annotations

from typing import Any

from backend import app as app_module


def test_save_parsed_writes_each_section(monkeypatch: Any) -> None:
    calls: list[dict[str, Any]] = []

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        return {"documents": []}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(payload)
        return {"ok": True}, None

    def fake_forward_delete(endpoint: str, params: dict[str, Any]) -> Any:
        raise AssertionError("forward_delete should not be called.")

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    monkeypatch.setattr(app_module, "forward_delete", fake_forward_delete)
    client = app_module.app.test_client()

    response = client.post(
        "/api/save-parsed",
        json={
            "database_name": "privacy-compliance",
            "collection_name": "policy_chunks",
            "document_id": "doc-123",
            "chunks": [
                {
                    "chunk_header_text": "Header A",
                    "chunk_text": "Text A",
                },
                {
                    "chunk_header_text": "Header B",
                    "chunk_text": "Text B",
                },
            ],
        },
    )

    assert response.status_code == 200
    chunk_calls = [c for c in calls if c.get("collection_name") == "policy_chunks"]
    assert len(chunk_calls) == 2
    first_document = chunk_calls[0]["document"]
    second_document = chunk_calls[1]["document"]
    assert first_document["chunk_index"] == 0
    assert first_document["chunk_header_text"] == "Header A"
    assert first_document["chunk_text"] == "Text A"
    assert second_document["chunk_index"] == 1
    assert second_document["chunk_header_text"] == "Header B"
    assert second_document["chunk_text"] == "Text B"


def test_save_parsed_accepts_parsed_header_and_text(monkeypatch: Any) -> None:
    """Parse-llm returns parsed_header_text and parsed_text; backend accepts them.
    Jurisdiction comes from source statute record, not from chunk content."""
    calls: list[dict[str, Any]] = []

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        if params.get("collection_name") == "statutes":
            return {"documents": [{"document_id": "doc-ccpa", "jurisdiction": "CA"}]}, None
        return {"documents": []}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(payload)
        return {"ok": True}, None

    def fake_forward_delete(endpoint: str, params: dict[str, Any]) -> Any:
        raise AssertionError("forward_delete should not be called.")

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    monkeypatch.setattr(app_module, "forward_delete", fake_forward_delete)
    client = app_module.app.test_client()

    response = client.post(
        "/api/save-parsed",
        json={
            "database_name": "privacy-compliance",
            "collection_name": "statute_chunks",
            "document_id": "doc-ccpa",
            "chunks": [
                {
                    "code_name": "California Consumer Privacy Act",
                    "jurisdiction": "California",
                    "parsed_header_text": "General Duties of Businesses",
                    "parsed_text": "# 1798.100. General Duties...",
                    "section": "§ 1798.100",
                }
            ],
        },
    )

    assert response.status_code == 200
    chunk_calls = [c for c in calls if c.get("collection_name") == "statute_chunks"]
    assert len(chunk_calls) == 1
    saved_document = chunk_calls[0]["document"]
    assert saved_document["chunk_header_text"] == "General Duties of Businesses"
    assert saved_document["chunk_text"].startswith("# 1798.100. General Duties")
    assert saved_document["code_name"] == "California Consumer Privacy Act"
    assert saved_document["jurisdiction"] == "CA"
    assert saved_document["section"] == "§ 1798.100"
    assert "_id" not in saved_document


def test_save_parsed_statute_chunks_no_inferred_jurisdiction(monkeypatch: Any) -> None:
    """When source statute has no jurisdiction, chunk must not have inferred jurisdiction."""
    calls: list[dict[str, Any]] = []

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        if params.get("collection_name") == "statutes":
            return {"documents": [{"document_id": "doc-unknown"}]}, None
        return {"documents": []}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(payload)
        return {"ok": True}, None

    def fake_forward_delete(endpoint: str, params: dict[str, Any]) -> Any:
        raise AssertionError("forward_delete should not be called.")

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    monkeypatch.setattr(app_module, "forward_delete", fake_forward_delete)
    client = app_module.app.test_client()

    response = client.post(
        "/api/save-parsed",
        json={
            "database_name": "privacy-compliance",
            "collection_name": "statute_chunks",
            "document_id": "doc-unknown",
            "chunks": [
                {
                    "jurisdiction": "InferredFromContent",
                    "chunk_header_text": "Section 1",
                    "chunk_text": "Some California law text...",
                }
            ],
        },
    )

    assert response.status_code == 200
    chunk_calls = [c for c in calls if c.get("collection_name") == "statute_chunks"]
    assert len(chunk_calls) == 1
    saved_document = chunk_calls[0]["document"]
    assert "jurisdiction" not in saved_document


def test_save_parsed_preserves_llm_fields(monkeypatch: Any) -> None:
    calls: list[dict[str, Any]] = []

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        return {"documents": []}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(payload)
        return {"ok": True}, None

    def fake_forward_delete(endpoint: str, params: dict[str, Any]) -> Any:
        raise AssertionError("forward_delete should not be called.")

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    monkeypatch.setattr(app_module, "forward_delete", fake_forward_delete)
    client = app_module.app.test_client()

    response = client.post(
        "/api/save-parsed",
        json={
            "database_name": "privacy-compliance",
            "collection_name": "policy_chunks",
            "document_id": "doc-789",
            "chunks": [
                {
                    "_id": "should-be-removed",
                    "chunk_header_text": "Header C",
                    "chunk_text": "Text C",
                    "jurisdiction": "US",
                    "section": "1.2",
                }
            ],
        },
    )

    assert response.status_code == 200
    chunk_calls = [c for c in calls if c.get("collection_name") == "policy_chunks"]
    assert len(chunk_calls) == 1
    saved_document = chunk_calls[0]["document"]
    assert saved_document["document_id"] == "doc-789"
    assert saved_document["chunk_index"] == 0
    assert saved_document["jurisdiction"] == "US"
    assert saved_document["section"] == "1.2"
    assert "_id" not in saved_document


def test_save_parsed_deletes_existing_documents(monkeypatch: Any) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        calls.append(("get", params))
        return {"documents": [{"_id": "existing"}]}, None

    def fake_forward_delete(endpoint: str, params: dict[str, Any]) -> Any:
        calls.append(("delete", params))
        return {"deleted_count": 1}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(("post", payload))
        return {"ok": True}, None

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_delete", fake_forward_delete)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/save-parsed",
        json={
            "database_name": "privacy-compliance",
            "collection_name": "policy_chunks",
            "document_id": "doc-456",
            "chunks": [
                {
                    "chunk_header_text": "Header A",
                    "chunk_text": "Text A",
                }
            ],
        },
    )

    assert response.status_code == 200
    assert calls[0][0] == "get"
    assert calls[1][0] == "delete"
    post_calls = [c for c in calls if c[0] == "post"]
    assert len(post_calls) >= 1
    delete_params = calls[1][1]
    assert delete_params["database_name"] == "privacy-compliance"
    assert delete_params["collection_name"] == "policy_chunks"
    assert "doc-456" in delete_params["query"]
