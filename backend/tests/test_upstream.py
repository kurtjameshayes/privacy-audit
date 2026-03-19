"""Unit tests for backend/upstream.py: error sanitization, forward functions."""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from backend.upstream import (
    _sanitize_upstream_error,
    _forward_request,
    api_headers,
    forward_get,
    forward_post,
    forward_delete,
)


# ── _sanitize_upstream_error ──────────────────────────────────

class TestSanitizeUpstreamError:
    def test_maps_400(self):
        assert _sanitize_upstream_error("some detail", 400) == "Bad request to upstream service."

    def test_maps_401(self):
        assert _sanitize_upstream_error("token expired", 401) == "Upstream authentication failed."

    def test_maps_403(self):
        assert _sanitize_upstream_error("forbidden", 403) == "Upstream authorization denied."

    def test_maps_404(self):
        assert _sanitize_upstream_error("not found", 404) == "Upstream resource not found."

    def test_maps_429(self):
        assert _sanitize_upstream_error("too many", 429) == "Upstream rate limit exceeded."

    def test_maps_500(self):
        assert _sanitize_upstream_error("crash", 500) == "Upstream internal error."

    def test_maps_502(self):
        assert _sanitize_upstream_error("bad gateway", 502) == "Upstream service unavailable."

    def test_maps_503(self):
        assert _sanitize_upstream_error("down", 503) == "Upstream service unavailable."

    def test_maps_504(self):
        assert _sanitize_upstream_error("timeout", 504) == "Upstream request timed out."

    def test_unmapped_status_returns_generic(self):
        assert _sanitize_upstream_error("weird", 418) == "Upstream error (HTTP 418)."

    def test_does_not_leak_raw_message(self):
        raw = "Internal details: MongoDB connection failed at host db-primary:27017"
        result = _sanitize_upstream_error(raw, 500)
        assert "MongoDB" not in result
        assert "27017" not in result


# ── api_headers ───────────────────────────────────────────────

class TestApiHeaders:
    def test_includes_content_type(self):
        headers = api_headers()
        assert headers["Content-Type"] == "application/json"

    def test_includes_auth_when_key_set(self):
        with patch("backend.upstream.FIRECRAWL_API_KEY", "test-key"):
            headers = api_headers()
            assert headers["Authorization"] == "Bearer test-key"

    def test_no_auth_when_key_empty(self):
        with patch("backend.upstream.FIRECRAWL_API_KEY", ""):
            headers = api_headers()
            assert "Authorization" not in headers

    def test_no_auth_when_key_none(self):
        with patch("backend.upstream.FIRECRAWL_API_KEY", None):
            headers = api_headers()
            assert "Authorization" not in headers


# ── _forward_request ──────────────────────────────────────────

class TestForwardRequest:
    def test_returns_error_when_no_base_url(self):
        with patch("backend.upstream.API_BASE_URL", ""):
            data, err = _forward_request("GET", "/health")
            assert data is None
            assert err is not None
            assert err[1] == 500

    def test_returns_error_when_no_api_key(self):
        with patch("backend.upstream.API_BASE_URL", "http://localhost"):
            with patch("backend.upstream.FIRECRAWL_API_KEY", ""):
                data, err = _forward_request("GET", "/health")
                assert data is None
                assert err is not None
                assert err[1] == 500

    def test_returns_502_on_connection_error(self):
        with patch("backend.upstream.API_BASE_URL", "http://localhost"):
            with patch("backend.upstream.FIRECRAWL_API_KEY", "key"):
                with patch("backend.upstream._session") as mock_session:
                    import requests
                    mock_session.request.side_effect = requests.ConnectionError("refused")
                    data, err = _forward_request("GET", "/health")
                    assert data is None
                    assert err is not None
                    assert err[1] == 502

    def test_returns_sanitized_error_on_4xx(self):
        with patch("backend.upstream.API_BASE_URL", "http://localhost"):
            with patch("backend.upstream.FIRECRAWL_API_KEY", "key"):
                with patch("backend.upstream._session") as mock_session:
                    mock_resp = MagicMock()
                    mock_resp.status_code = 404
                    mock_resp.json.return_value = {"error": "secret internal detail"}
                    mock_session.request.return_value = mock_resp
                    data, err = _forward_request("GET", "/missing")
                    assert data is None
                    assert err is not None
                    assert "secret" not in err[0]
                    assert err[1] == 404

    def test_returns_json_on_success(self):
        with patch("backend.upstream.API_BASE_URL", "http://localhost"):
            with patch("backend.upstream.FIRECRAWL_API_KEY", "key"):
                with patch("backend.upstream._session") as mock_session:
                    mock_resp = MagicMock()
                    mock_resp.status_code = 200
                    mock_resp.json.return_value = {"documents": []}
                    mock_session.request.return_value = mock_resp
                    data, err = _forward_request("GET", "/docs")
                    assert err is None
                    assert data == {"documents": []}

    def test_returns_raw_text_on_non_json_success(self):
        with patch("backend.upstream.API_BASE_URL", "http://localhost"):
            with patch("backend.upstream.FIRECRAWL_API_KEY", "key"):
                with patch("backend.upstream._session") as mock_session:
                    mock_resp = MagicMock()
                    mock_resp.status_code = 200
                    mock_resp.json.side_effect = ValueError("no json")
                    mock_resp.text = "plain text"
                    mock_session.request.return_value = mock_resp
                    data, err = _forward_request("GET", "/docs")
                    assert err is None
                    assert data == {"raw": "plain text"}


# ── forward_post / forward_get / forward_delete convenience wrappers ──

class TestForwardWrappers:
    def test_forward_post_delegates(self):
        with patch("backend.upstream._forward_request") as mock:
            mock.return_value = ({"ok": True}, None)
            data, err = forward_post("/ep", {"key": "val"})
            assert data == {"ok": True}
            mock.assert_called_once_with("POST", "/ep", payload={"key": "val"}, timeout=60)

    def test_forward_get_delegates(self):
        with patch("backend.upstream._forward_request") as mock:
            mock.return_value = ({"docs": []}, None)
            data, err = forward_get("/ep", {"q": "1"})
            assert data == {"docs": []}
            mock.assert_called_once_with("GET", "/ep", params={"q": "1"})

    def test_forward_delete_delegates(self):
        with patch("backend.upstream._forward_request") as mock:
            mock.return_value = (None, None)
            data, err = forward_delete("/ep", {"id": "1"})
            mock.assert_called_once_with("DELETE", "/ep", params={"id": "1"})
