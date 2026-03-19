"""Integration tests for gather routes: search, crawl, upload, save-policy."""
from __future__ import annotations

import io
from typing import Any

import pytest

from backend import app as app_module
from backend.routes import gather as gather_module


@pytest.fixture()
def client():
    app_module.app.config["TESTING"] = True
    with app_module.app.test_client() as c:
        yield c


class TestGatherRoute:
    def test_requires_query(self, client):
        resp = client.post("/api/gather", json={})
        assert resp.status_code == 400
        assert "query" in resp.get_json()["error"].lower()

    def test_empty_query_rejected(self, client):
        resp = client.post("/api/gather", json={"query": "   "})
        assert resp.status_code == 400

    def test_forwards_to_upstream(self, client, monkeypatch):
        calls: list[dict] = []

        def fake_post(endpoint, payload):
            calls.append(payload)
            return {"results": [{"url": "https://example.com"}]}, None

        monkeypatch.setattr(gather_module, "forward_post", fake_post)

        resp = client.post("/api/gather", json={"query": "privacy policy"})
        assert resp.status_code == 200
        assert len(calls) == 1
        assert calls[0]["query"] == "privacy policy"

    def test_upstream_error_forwarded(self, client, monkeypatch):
        def fake_post(endpoint, payload):
            return None, ("service down", 502)

        monkeypatch.setattr(gather_module, "forward_post", fake_post)

        resp = client.post("/api/gather", json={"query": "test"})
        assert resp.status_code == 502


class TestCrawlRoute:
    def test_requires_url(self, client):
        resp = client.post("/api/crawl", json={})
        assert resp.status_code == 400

    def test_rejects_non_http_url(self, client):
        resp = client.post("/api/crawl", json={"url": "ftp://example.com"})
        assert resp.status_code == 400
        assert "http" in resp.get_json()["error"].lower()

    def test_valid_url_forwards(self, client, monkeypatch):
        calls: list[dict] = []

        def fake_post(endpoint, payload):
            calls.append(payload)
            return {"pages": []}, None

        monkeypatch.setattr(gather_module, "forward_post", fake_post)

        resp = client.post("/api/crawl", json={"url": "https://example.com/privacy"})
        assert resp.status_code == 200
        assert calls[0]["url"] == "https://example.com/privacy"

    def test_depth_clamped(self, client, monkeypatch):
        calls: list[dict] = []

        def fake_post(endpoint, payload):
            calls.append(payload)
            return {"pages": []}, None

        monkeypatch.setattr(gather_module, "forward_post", fake_post)

        resp = client.post("/api/crawl", json={"url": "https://x.com", "depth": 999})
        assert resp.status_code == 200
        assert calls[0]["depth"] <= 10


class TestUploadDocument:
    def test_rejects_no_file(self, client):
        resp = client.post("/api/upload-document")
        assert resp.status_code == 400

    def test_rejects_unsupported_extension(self, client):
        data = {"file": (io.BytesIO(b"data"), "test.exe")}
        resp = client.post(
            "/api/upload-document",
            data=data,
            content_type="multipart/form-data",
        )
        assert resp.status_code == 400
        assert "unsupported" in resp.get_json()["error"].lower()

    def test_accepts_txt_file(self, client):
        data = {"file": (io.BytesIO(b"Privacy policy text"), "policy.txt")}
        resp = client.post(
            "/api/upload-document",
            data=data,
            content_type="multipart/form-data",
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["combined_text"] == "Privacy policy text"
        assert body["filename"] == "policy.txt"

    def test_accepts_html_file(self, client):
        data = {"file": (io.BytesIO(b"<html><body>Policy</body></html>"), "page.html")}
        resp = client.post(
            "/api/upload-document",
            data=data,
            content_type="multipart/form-data",
        )
        assert resp.status_code == 200


class TestSavePolicy:
    def test_requires_url_and_text(self, client):
        resp = client.post("/api/save-policy", json={"url": "https://x.com"})
        assert resp.status_code == 400

        resp2 = client.post("/api/save-policy", json={"combined_text": "text"})
        assert resp2.status_code == 400

    def test_statute_requires_jurisdiction(self, client):
        resp = client.post(
            "/api/save-policy",
            json={"url": "https://x.com", "combined_text": "text", "mode": "statute"},
        )
        assert resp.status_code == 400
        assert "jurisdiction" in resp.get_json()["error"].lower()

    def test_saves_policy_and_triggers_workflow(self, client, monkeypatch):
        writes: list[dict] = []

        def fake_post(endpoint, payload):
            writes.append({"endpoint": endpoint, "payload": payload})
            return {"ok": True}, None

        def fake_get(endpoint, params):
            return {"documents": []}, None

        def fake_delete(endpoint, params):
            return None, None

        monkeypatch.setattr(gather_module, "forward_post", fake_post)
        monkeypatch.setattr(gather_module, "forward_get", fake_get)
        monkeypatch.setattr(gather_module, "forward_delete", fake_delete)

        resp = client.post(
            "/api/save-policy",
            json={
                "url": "https://example.com/privacy",
                "combined_text": "Full policy text here",
                "company_name": "Acme Corp",
            },
        )

        assert resp.status_code == 200
        data = resp.get_json()
        assert "document_id" in data

        policy_writes = [
            w for w in writes
            if w["endpoint"] == "/write_to_collection"
            and w["payload"].get("collection_name") == "policies"
        ]
        assert len(policy_writes) == 1

    def test_saves_statute_with_jurisdiction(self, client, monkeypatch):
        writes: list[dict] = []

        def fake_post(endpoint, payload):
            writes.append(payload)
            return {"ok": True}, None

        def fake_get(endpoint, params):
            return {"documents": []}, None

        def fake_delete(endpoint, params):
            return None, None

        monkeypatch.setattr(gather_module, "forward_post", fake_post)
        monkeypatch.setattr(gather_module, "forward_get", fake_get)
        monkeypatch.setattr(gather_module, "forward_delete", fake_delete)

        resp = client.post(
            "/api/save-policy",
            json={
                "url": "https://example.com/ccpa",
                "combined_text": "Statute text",
                "mode": "statute",
                "jurisdiction": "CA",
            },
        )

        assert resp.status_code == 200
        statute_writes = [
            w for w in writes
            if w.get("collection_name") == "statutes"
        ]
        assert len(statute_writes) == 1
        assert statute_writes[0]["document"]["jurisdiction"] == "CA"
