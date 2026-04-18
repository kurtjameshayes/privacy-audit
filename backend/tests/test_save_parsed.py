from __future__ import annotations

import json
import uuid
from typing import Any

import pytest

from backend import app as app_module
from backend.routes import documents as docs_module

CHUNK_COLLECTIONS = frozenset({"policy_chunks", "statute_chunks"})


class _ChunkUpstreamStore:
    """In-memory chunk rows so GET /documents can serve staged rows during promote."""

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    def record_post_payload(self, payload: dict[str, Any]) -> None:
        coll = payload.get("collection_name")
        doc = payload.get("document")
        if coll in CHUNK_COLLECTIONS and isinstance(doc, dict):
            self.rows.append({**doc, "__coll": coll})

    def make_get(self, *, statutes_response: dict[str, Any] | None = None) -> Any:
        def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
            coll = params.get("collection_name", "")
            if coll == "statutes" and statutes_response is not None:
                return statutes_response, None
            if endpoint != "/documents" or coll not in CHUNK_COLLECTIONS:
                return {"documents": []}, None
            qraw = params.get("query") or "{}"
            try:
                q = json.loads(qraw) if isinstance(qraw, str) else qraw
            except json.JSONDecodeError:
                q = {}
            want = str(q.get("document_id", "")) if isinstance(q, dict) else ""
            out: list[dict[str, Any]] = []
            for r in self.rows:
                if r.get("__coll") != coll:
                    continue
                if str(r.get("document_id", "")) != want:
                    continue
                out.append({k: v for k, v in r.items() if k != "__coll"})
            return {"documents": out}, None

        return fake_forward_get

    def make_delete(self) -> Any:
        def fake_forward_delete(endpoint: str, params: dict[str, Any]) -> Any:
            if endpoint != "/documents":
                return None, None
            coll = params.get("collection_name", "")
            if coll not in CHUNK_COLLECTIONS:
                return None, None
            qraw = params.get("query") or "{}"
            try:
                q = json.loads(qraw) if isinstance(qraw, str) else qraw
            except json.JSONDecodeError:
                q = {}
            want = str(q.get("document_id", "")) if isinstance(q, dict) else ""
            self.rows[:] = [
                r
                for r in self.rows
                if not (r.get("__coll") == coll and str(r.get("document_id", "")) == want)
            ]
            return None, None

        return fake_forward_delete


def _noop_delete(endpoint: str, params: dict[str, Any]) -> Any:
    return None, None


@pytest.fixture(autouse=True)
def _sync_save_parsed_background_threads(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run save-parsed prepare thread synchronously so tests see full pipeline in post_calls."""

    class SyncFakeThread:
        def __init__(
            self,
            group: None = None,
            target: Any = None,
            name: str | None = None,
            args: tuple[Any, ...] = (),
            kwargs: dict[str, Any] | None = None,
            *,
            daemon: bool = False,
        ) -> None:
            self._target = target
            self._args = args

        def start(self) -> None:
            if self._target is not None:
                self._target(*self._args)

    monkeypatch.setattr(docs_module.threading, "Thread", SyncFakeThread)


def test_save_parsed_runs_subsection_pipeline(monkeypatch: Any) -> None:
    """Save-parsed runs create-subsections, vector-index, create-vector-index and sets vector_indexed."""
    post_calls: list[tuple[str, dict[str, Any]]] = []
    store = _ChunkUpstreamStore()
    stat_docs = {"documents": [{"document_id": "doc-ccpa", "jurisdiction": "CA"}]}

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        post_calls.append((endpoint, payload))
        store.record_post_payload(payload)
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_get", store.make_get(statutes_response=stat_docs))
    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
    monkeypatch.setattr(docs_module, "forward_delete", store.make_delete())
    client = app_module.app.test_client()

    response = client.post(
        "/api/save-parsed",
        json={
            "database_name": "privacy-compliance",
            "collection_name": "statute_chunks",
            "document_id": "doc-ccpa",
            "chunks": [
                {
                    "parsed_header_text": "Section 1",
                    "parsed_text": "Text of section 1.",
                },
            ],
        },
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body.get("preparation_status") == "pending"
    assert body.get("preparation_message")
    endpoints = [e for e, _ in post_calls]
    assert "/create-statute-subsections" in endpoints
    assert "/create-embeddings" in endpoints
    assert "/create-vector-index" in endpoints
    vi_call = next((p for e, p in post_calls if e == "/create-embeddings"), None)
    assert vi_call is not None
    assert vi_call.get("text_column") == "subchunk_text"
    assert vi_call.get("source_collection_name") == "statute_sub_chunks"


def test_save_parsed_writes_each_section(monkeypatch: Any) -> None:
    calls: list[dict[str, Any]] = []
    store = _ChunkUpstreamStore()

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(payload)
        store.record_post_payload(payload)
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_get", store.make_get())
    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
    monkeypatch.setattr(docs_module, "forward_delete", store.make_delete())
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
    chunk_calls = [
        c for c in calls
        if c.get("collection_name") == "policy_chunks" and "document" in c
    ]
    staging_writes = [
        c for c in chunk_calls
        if str(c["document"].get("document_id", "")).startswith("staging-")
    ]
    final_writes = [c for c in chunk_calls if c["document"].get("document_id") == "doc-123"]
    assert len(staging_writes) == 2
    assert len(final_writes) == 2
    first_document = staging_writes[0]["document"]
    second_document = staging_writes[1]["document"]
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
    store = _ChunkUpstreamStore()
    stat_docs = {"documents": [{"document_id": "doc-ccpa", "jurisdiction": "CA"}]}

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(payload)
        store.record_post_payload(payload)
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_get", store.make_get(statutes_response=stat_docs))
    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
    monkeypatch.setattr(docs_module, "forward_delete", store.make_delete())
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
    chunk_calls = [
        c for c in calls
        if c.get("collection_name") == "statute_chunks" and "document" in c
    ]
    final_writes = [c for c in chunk_calls if c["document"].get("document_id") == "doc-ccpa"]
    assert len(final_writes) == 1
    saved_document = final_writes[0]["document"]
    assert saved_document["chunk_header_text"] == "General Duties of Businesses"
    assert saved_document["chunk_text"].startswith("# 1798.100. General Duties")
    assert saved_document["code_name"] == "California Consumer Privacy Act"
    assert saved_document["jurisdiction"] == "CA"
    assert saved_document["section"] == "§ 1798.100"
    assert "_id" not in saved_document


def test_save_parsed_statute_chunks_no_inferred_jurisdiction(monkeypatch: Any) -> None:
    """When source statute has no jurisdiction, chunk must not have inferred jurisdiction."""
    calls: list[dict[str, Any]] = []
    store = _ChunkUpstreamStore()
    stat_docs = {"documents": [{"document_id": "doc-unknown"}]}

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(payload)
        store.record_post_payload(payload)
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_get", store.make_get(statutes_response=stat_docs))
    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
    monkeypatch.setattr(docs_module, "forward_delete", store.make_delete())
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
    chunk_calls = [
        c for c in calls
        if c.get("collection_name") == "statute_chunks" and "document" in c
    ]
    final_writes = [c for c in chunk_calls if c["document"].get("document_id") == "doc-unknown"]
    assert len(final_writes) == 1
    saved_document = final_writes[0]["document"]
    assert "jurisdiction" not in saved_document


def test_save_parsed_preserves_llm_fields(monkeypatch: Any) -> None:
    calls: list[dict[str, Any]] = []
    store = _ChunkUpstreamStore()

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(payload)
        store.record_post_payload(payload)
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_get", store.make_get())
    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
    monkeypatch.setattr(docs_module, "forward_delete", store.make_delete())
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
    chunk_calls = [
        c for c in calls
        if c.get("collection_name") == "policy_chunks" and "document" in c
    ]
    staging_writes = [
        c for c in chunk_calls
        if str(c["document"].get("document_id", "")).startswith("staging-")
    ]
    assert len(staging_writes) == 1
    saved_document = staging_writes[0]["document"]
    assert saved_document["document_id"].startswith("staging-")
    assert saved_document["chunk_index"] == 0
    assert saved_document["jurisdiction"] == "US"
    assert saved_document["section"] == "1.2"
    assert "_id" not in saved_document

    promoted = [
        c for c in calls
        if c.get("collection_name") == "policy_chunks"
        and "document" in c
        and c["document"].get("document_id") == "doc-789"
    ]
    assert len(promoted) == 1
    assert promoted[0]["document"]["chunk_text"] == "Text C"


def test_save_parsed_removes_linefeeds(monkeypatch: Any) -> None:
    """Chunk header and text are normalized to single-line strings (no newlines)."""
    calls: list[dict[str, Any]] = []
    store = _ChunkUpstreamStore()

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append(payload)
        store.record_post_payload(payload)
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_get", store.make_get())
    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
    monkeypatch.setattr(docs_module, "forward_delete", store.make_delete())
    client = app_module.app.test_client()

    response = client.post(
        "/api/save-parsed",
        json={
            "database_name": "privacy-compliance",
            "collection_name": "policy_chunks",
            "document_id": "doc-789",
            "chunks": [
                {
                    "chunk_header_text": "Header\nWith\nLines",
                    "chunk_text": "First paragraph.\n\nSecond paragraph.\nMore text.",
                }
            ],
        },
    )

    assert response.status_code == 200
    chunk_calls = [
        c for c in calls
        if c.get("collection_name") == "policy_chunks" and "document" in c
    ]
    staging_writes = [
        c for c in chunk_calls
        if str(c["document"].get("document_id", "")).startswith("staging-")
    ]
    assert len(staging_writes) == 1
    saved_document = staging_writes[0]["document"]
    assert saved_document["chunk_header_text"] == "Header With Lines"
    assert saved_document["chunk_text"] == "First paragraph. Second paragraph. More text."
    assert "\n" not in saved_document["chunk_header_text"]
    assert "\n" not in saved_document["chunk_text"]


def test_save_parsed_deletes_existing_documents(monkeypatch: Any) -> None:
    get_calls: list[dict[str, Any]] = []
    delete_calls: list[dict[str, Any]] = []
    post_calls: list[dict[str, Any]] = []
    store = _ChunkUpstreamStore()
    store_delete = store.make_delete()

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        get_calls.append(params)
        return store.make_get()(endpoint, params)

    def fake_forward_delete(endpoint: str, params: dict[str, Any]) -> Any:
        delete_calls.append(params)
        return store_delete(endpoint, params)

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        post_calls.append(payload)
        store.record_post_payload(payload)
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(docs_module, "forward_delete", fake_forward_delete)
    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
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
    assert len(post_calls) >= 1
    chunk_deletes = [
        d for d in delete_calls
        if d.get("collection_name") == "policy_chunks"
    ]
    assert len(chunk_deletes) >= 1
    assert chunk_deletes[0]["database_name"] == "privacy-compliance"
    assert "doc-456" in chunk_deletes[0]["query"]


def test_save_parsed_promotes_staged_rows_via_fetch_delete_rewrite(monkeypatch: Any) -> None:
    """Finalize uses GET+DELETE+rewrite append (no bulk update endpoint on upstream)."""
    fixed = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    monkeypatch.setattr(docs_module.uuid, "uuid4", lambda: fixed)
    staging_id = f"staging-{fixed}"

    post_calls: list[tuple[str, dict[str, Any]]] = []

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        q = params.get("query") or ""
        if staging_id in q:
            return {
                "documents": [
                    {
                        "document_id": staging_id,
                        "chunk_index": 0,
                        "chunk_header_text": "H",
                        "chunk_text": "T",
                    }
                ]
            }, None
        return {"documents": []}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        post_calls.append((endpoint, payload))
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
    monkeypatch.setattr(docs_module, "forward_delete", _noop_delete)
    client = app_module.app.test_client()

    response = client.post(
        "/api/save-parsed",
        json={
            "database_name": "privacy-compliance",
            "collection_name": "policy_chunks",
            "document_id": "doc-promo",
            "chunks": [{"chunk_header_text": "H", "chunk_text": "T"}],
        },
    )

    assert response.status_code == 200
    endpoints = [e for e, _ in post_calls]
    assert "/update_documents" not in endpoints
    final_writes = [
        p for e, p in post_calls
        if e == "/write_to_collection"
        and p.get("collection_name") == "policy_chunks"
        and p.get("document", {}).get("document_id") == "doc-promo"
    ]
    assert len(final_writes) == 1
    assert final_writes[0]["document"]["chunk_text"] == "T"


def test_save_parsed_returns_pending_before_background_pipeline(monkeypatch: Any) -> None:
    """HTTP response returns before pipeline runs when Thread.start does not invoke target."""
    started: list[bool] = []

    class DeferredThread:
        def __init__(
            self,
            group: None = None,
            target: Any = None,
            name: str | None = None,
            args: tuple[Any, ...] = (),
            kwargs: dict[str, Any] | None = None,
            *,
            daemon: bool = False,
        ) -> None:
            self._target = target
            self._args = args

        def start(self) -> None:
            started.append(True)

    post_calls: list[tuple[str, dict[str, Any]]] = []
    store = _ChunkUpstreamStore()

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        post_calls.append((endpoint, payload))
        store.record_post_payload(payload)
        return {"ok": True}, None

    monkeypatch.setattr(docs_module, "forward_get", store.make_get())
    monkeypatch.setattr(docs_module, "forward_post", fake_forward_post)
    monkeypatch.setattr(docs_module, "forward_delete", _noop_delete)
    monkeypatch.setattr(docs_module.threading, "Thread", DeferredThread)

    response = app_module.app.test_client().post(
        "/api/save-parsed",
        json={
            "database_name": "privacy-compliance",
            "collection_name": "policy_chunks",
            "document_id": "doc-async",
            "chunks": [{"chunk_header_text": "H", "chunk_text": "T"}],
        },
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data.get("preparation_status") == "pending"
    assert data.get("preparation_message")
    assert started == [True]
    endpoints = [e for e, _ in post_calls]
    assert "/create-embeddings" not in endpoints
    assert "/create-vector-index" not in endpoints
