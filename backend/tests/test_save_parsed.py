from __future__ import annotations

from typing import Any

from backend import app as app_module


def test_save_parsed_writes_each_section(monkeypatch: Any) -> None:
    calls: list[dict[str, Any]] = []

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(payload)
        return {"ok": True}, None

    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
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
