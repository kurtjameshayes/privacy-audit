"""Unit tests for backend/utils.py: strip_dollar_keys, get_documents."""
from __future__ import annotations

from typing import Any

from backend.utils import strip_dollar_keys, get_documents


# ── strip_dollar_keys ─────────────────────────────────────────

class TestStripDollarKeys:
    def test_removes_top_level_dollar_keys(self):
        data = {"name": "Alice", "$set": {"x": 1}, "age": 30}
        assert strip_dollar_keys(data) == {"name": "Alice", "age": 30}

    def test_removes_nested_dollar_keys(self):
        data = {"query": {"status": "active", "$gt": 5, "nested": {"$in": [1, 2], "ok": True}}}
        result = strip_dollar_keys(data)
        assert result == {"query": {"status": "active", "nested": {"ok": True}}}

    def test_handles_deeply_nested(self):
        data = {"a": {"b": {"c": {"$evil": True, "safe": 1}}}}
        assert strip_dollar_keys(data) == {"a": {"b": {"c": {"safe": 1}}}}

    def test_handles_lists(self):
        data = [{"$drop": True, "keep": 1}, {"$unset": "x", "val": 2}]
        assert strip_dollar_keys(data) == [{"keep": 1}, {"val": 2}]

    def test_mixed_list_and_dict(self):
        data = {"items": [{"$set": "bad", "name": "ok"}, "plain"]}
        assert strip_dollar_keys(data) == {"items": [{"name": "ok"}, "plain"]}

    def test_empty_dict(self):
        assert strip_dollar_keys({}) == {}

    def test_empty_list(self):
        assert strip_dollar_keys([]) == []

    def test_scalar_passthrough(self):
        assert strip_dollar_keys("hello") == "hello"
        assert strip_dollar_keys(42) == 42
        assert strip_dollar_keys(None) is None

    def test_all_dollar_keys_returns_empty(self):
        data = {"$set": 1, "$unset": 2, "$gt": 3}
        assert strip_dollar_keys(data) == {}

    def test_preserves_non_dollar_keys_with_dollar_in_value(self):
        data = {"price": "$100", "note": "uses $set internally"}
        assert strip_dollar_keys(data) == data


# ── get_documents ─────────────────────────────────────────────

class TestGetDocuments:
    def test_returns_documents_list(self):
        def fake_get(endpoint: str, params: dict[str, Any]):
            return {"documents": [{"_id": "1"}, {"_id": "2"}]}, None

        result = get_documents(fake_get, "db", "coll")
        assert len(result) == 2
        assert result[0]["_id"] == "1"

    def test_returns_empty_on_error(self):
        def fake_get(endpoint: str, params: dict[str, Any]):
            return None, ("fail", 500)

        result = get_documents(fake_get, "db", "coll")
        assert result == []

    def test_handles_data_key(self):
        def fake_get(endpoint: str, params: dict[str, Any]):
            return {"data": [{"_id": "x"}]}, None

        result = get_documents(fake_get, "db", "coll")
        assert len(result) == 1

    def test_handles_results_key(self):
        def fake_get(endpoint: str, params: dict[str, Any]):
            return {"results": [{"_id": "y"}]}, None

        result = get_documents(fake_get, "db", "coll")
        assert len(result) == 1

    def test_handles_list_response(self):
        def fake_get(endpoint: str, params: dict[str, Any]):
            return [{"_id": "z"}], None

        result = get_documents(fake_get, "db", "coll")
        assert len(result) == 1

    def test_passes_query(self):
        captured: list[dict] = []

        def fake_get(endpoint: str, params: dict[str, Any]):
            captured.append(params)
            return {"documents": []}, None

        get_documents(fake_get, "db", "coll", {"doc_id": "abc"})
        assert "query" in captured[0]
        assert '"doc_id"' in captured[0]["query"]

    def test_no_query_when_none(self):
        captured: list[dict] = []

        def fake_get(endpoint: str, params: dict[str, Any]):
            captured.append(params)
            return {"documents": []}, None

        get_documents(fake_get, "db", "coll", None)
        assert "query" not in captured[0]
