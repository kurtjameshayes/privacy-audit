"""Shared fixtures for backend tests."""
from __future__ import annotations

from typing import Any

import pytest

from backend import app as app_module


READY_WORKFLOW = {
    "document_id": "doc-1",
    "document_type": "policy",
    "steps": {
        "gathered": {"completed": True, "completed_at": "2024-01-01T00:00:00Z"},
        "parsed": {"completed": True, "completed_at": "2024-01-01T00:00:00Z"},
        "vector_indexed": {"completed": True, "completed_at": "2024-01-01T00:00:00Z"},
    },
    "ready_for_compliance": True,
}


@pytest.fixture()
def client():
    """Flask test client with testing mode enabled."""
    app_module.app.config["TESTING"] = True
    with app_module.app.test_client() as c:
        yield c


@pytest.fixture()
def mock_upstream(monkeypatch):
    """Provides helpers to install fake forward_get / forward_post / forward_delete."""
    class Recorder:
        def __init__(self):
            self.get_calls: list[tuple[str, dict[str, Any]]] = []
            self.post_calls: list[tuple[str, dict[str, Any]]] = []
            self.delete_calls: list[tuple[str, dict[str, Any]]] = []
            self._get_handler = lambda ep, p: ({"documents": []}, None)
            self._post_handler = lambda ep, p, **kw: ({"ok": True}, None)
            self._delete_handler = lambda ep, p: (None, None)

        def set_get(self, fn):
            self._get_handler = fn

        def set_post(self, fn):
            self._post_handler = fn

        def set_delete(self, fn):
            self._delete_handler = fn

        def _forward_get(self, endpoint, params):
            self.get_calls.append((endpoint, params))
            return self._get_handler(endpoint, params)

        def _forward_post(self, endpoint, payload, **kwargs):
            self.post_calls.append((endpoint, payload))
            return self._post_handler(endpoint, payload)

        def _forward_delete(self, endpoint, params):
            self.delete_calls.append((endpoint, params))
            return self._delete_handler(endpoint, params)

    rec = Recorder()
    monkeypatch.setattr(app_module, "forward_get", rec._forward_get)
    monkeypatch.setattr(app_module, "forward_post", rec._forward_post)
    monkeypatch.setattr(app_module, "forward_delete", rec._forward_delete)
    return rec
