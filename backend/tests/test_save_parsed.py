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
                    "chunk_text_header": "Header A",
                    "chunk_text": "Text A",
                },
                {
                    "chunk_text_header": "Header B",
                    "chunk_text": "Text B",
                },
            ],
        },
    )

    assert response.status_code == 200
    assert len(calls) == 2
    first_document = calls[0]["document"]
    second_document = calls[1]["document"]
    assert first_document["chunk_index"] == 0
    assert first_document["chunk_text_header"] == "Header A"
    assert first_document["chunk_text"] == "Text A"
    assert second_document["chunk_index"] == 1
    assert second_document["chunk_text_header"] == "Header B"
    assert second_document["chunk_text"] == "Text B"


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
                    "chunk_text_header": "Header A",
                    "chunk_text": "Text A",
                }
            ],
        },
    )

    assert response.status_code == 200
    assert calls[0][0] == "get"
    assert calls[1][0] == "delete"
    assert calls[2][0] == "post"
    delete_params = calls[1][1]
    assert delete_params["database_name"] == "privacy-compliance"
    assert delete_params["collection_name"] == "policy_chunks"
    assert "doc-456" in delete_params["query"]
