"""Integration tests for API key authentication middleware."""
from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from backend import app as app_module
from backend.routes import gather as gather_module


@pytest.fixture()
def client():
    app_module.app.config["TESTING"] = True
    with app_module.app.test_client() as c:
        yield c


class TestAuthMiddleware:
    def test_health_is_always_public(self, client):
        with patch("backend.app.APP_API_KEY", "secret-key"):
            resp = client.get("/api/health")
            assert resp.status_code == 200

    def test_static_routes_bypass_auth(self, client):
        with patch("backend.app.APP_API_KEY", "secret-key"):
            resp = client.get("/")
            assert resp.status_code in (200, 503)

    def test_api_blocked_without_key(self, client):
        with patch("backend.app.APP_API_KEY", "secret-key"):
            resp = client.post("/api/gather", json={"query": "test"})
            assert resp.status_code == 401
            data = resp.get_json()
            assert data["error"] == "Unauthorized"

    def test_api_allowed_with_correct_key(self, client, monkeypatch):
        def fake_post(endpoint, payload):
            return {"results": []}, None

        monkeypatch.setattr(gather_module, "forward_post", fake_post)

        with patch("backend.app.APP_API_KEY", "secret-key"):
            resp = client.post(
                "/api/gather",
                json={"query": "test query"},
                headers={"Authorization": "Bearer secret-key"},
            )
            assert resp.status_code == 200

    def test_api_blocked_with_wrong_key(self, client):
        with patch("backend.app.APP_API_KEY", "secret-key"):
            resp = client.post(
                "/api/gather",
                json={"query": "test"},
                headers={"Authorization": "Bearer wrong-key"},
            )
            assert resp.status_code == 401

    def test_no_auth_when_key_not_configured(self, client, monkeypatch):
        def fake_post(endpoint, payload):
            return {"results": []}, None

        monkeypatch.setattr(gather_module, "forward_post", fake_post)

        with patch("backend.app.APP_API_KEY", ""):
            resp = client.post("/api/gather", json={"query": "test"})
            assert resp.status_code == 200

    def test_bearer_prefix_stripped(self, client, monkeypatch):
        def fake_post(endpoint, payload):
            return {"results": []}, None

        monkeypatch.setattr(gather_module, "forward_post", fake_post)

        with patch("backend.app.APP_API_KEY", "my-token"):
            resp = client.post(
                "/api/gather",
                json={"query": "test"},
                headers={"Authorization": "Bearer my-token"},
            )
            assert resp.status_code == 200

    def test_raw_token_without_bearer_prefix(self, client, monkeypatch):
        def fake_post(endpoint, payload):
            return {"results": []}, None

        monkeypatch.setattr(gather_module, "forward_post", fake_post)

        with patch("backend.app.APP_API_KEY", "my-token"):
            resp = client.post(
                "/api/gather",
                json={"query": "test"},
                headers={"Authorization": "my-token"},
            )
            assert resp.status_code == 200
