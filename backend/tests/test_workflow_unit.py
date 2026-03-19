"""Unit tests for backend/workflow.py: upsert_workflow_state, get_workflow_state, helpers."""
from __future__ import annotations

import json
from typing import Any

from backend.workflow import (
    get_workflow_state,
    upsert_workflow_state,
    _missing_steps,
    assert_policy_ready_for_compliance,
    WORKFLOW_STEPS,
)


# ── get_workflow_state ────────────────────────────────────────

class TestGetWorkflowState:
    def test_returns_first_matching_doc(self):
        state = {
            "document_id": "doc-1",
            "document_type": "policy",
            "steps": {"gathered": {"completed": True}},
        }

        def fake_get(endpoint, params):
            return {"documents": [state]}, None

        result = get_workflow_state(fake_get, "db", "doc-1", "policy")
        assert result is not None
        assert result["document_id"] == "doc-1"

    def test_returns_none_when_not_found(self):
        def fake_get(endpoint, params):
            return {"documents": []}, None

        result = get_workflow_state(fake_get, "db", "doc-missing", "policy")
        assert result is None

    def test_returns_none_on_upstream_error(self):
        def fake_get(endpoint, params):
            return None, ("error", 500)

        result = get_workflow_state(fake_get, "db", "doc-1", "policy")
        assert result is None


# ── upsert_workflow_state ─────────────────────────────────────

class TestUpsertWorkflowState:
    def test_creates_new_state_with_upsert_id(self):
        writes: list[dict] = []

        def fake_get(endpoint, params):
            return {"documents": []}, None

        def fake_post(endpoint, payload):
            writes.append(payload)
            return {"ok": True}, None

        def fake_delete(endpoint, params):
            return None, None

        upsert_workflow_state(
            fake_get, fake_post, fake_delete,
            "db", "doc-new", "policy", "gathered",
        )

        assert len(writes) == 1
        doc = writes[0]["document"]
        assert doc["document_id"] == "doc-new"
        assert doc["document_type"] == "policy"
        assert doc["steps"]["gathered"]["completed"] is True
        assert "_upsert_id" in doc

    def test_updates_existing_preserves_created_at(self):
        existing = {
            "document_id": "doc-1",
            "document_type": "policy",
            "steps": {"gathered": {"completed": True, "completed_at": "2024-01-01T00:00:00Z"}},
            "created_at": "2024-01-01T00:00:00Z",
            "_upsert_id": "old-uid",
        }
        writes: list[dict] = []
        deletes: list[dict] = []

        def fake_get(endpoint, params):
            return {"documents": [existing]}, None

        def fake_post(endpoint, payload):
            writes.append(payload)
            return {"ok": True}, None

        def fake_delete(endpoint, params):
            deletes.append(params)
            return None, None

        upsert_workflow_state(
            fake_get, fake_post, fake_delete,
            "db", "doc-1", "policy", "parsed",
        )

        assert len(writes) == 1
        doc = writes[0]["document"]
        assert doc["steps"]["gathered"]["completed"] is True
        assert doc["steps"]["parsed"]["completed"] is True
        assert doc["created_at"] == "2024-01-01T00:00:00Z"
        assert doc["_upsert_id"] != "old-uid"
        assert len(deletes) == 1
        assert '"old-uid"' in deletes[0].get("query", "")

    def test_ignores_invalid_step(self):
        writes: list[dict] = []

        def fake_get(endpoint, params):
            return {"documents": []}, None

        def fake_post(endpoint, payload):
            writes.append(payload)
            return {"ok": True}, None

        def fake_delete(endpoint, params):
            return None, None

        upsert_workflow_state(
            fake_get, fake_post, fake_delete,
            "db", "doc-1", "policy", "invalid_step",
        )

        assert len(writes) == 0

    def test_ready_for_compliance_when_all_steps_complete(self):
        existing = {
            "document_id": "doc-1",
            "document_type": "policy",
            "steps": {
                "gathered": {"completed": True, "completed_at": "t"},
                "parsed": {"completed": True, "completed_at": "t"},
            },
            "_upsert_id": "uid-x",
        }
        writes: list[dict] = []

        def fake_get(endpoint, params):
            return {"documents": [existing]}, None

        def fake_post(endpoint, payload):
            writes.append(payload)
            return {"ok": True}, None

        def fake_delete(endpoint, params):
            return None, None

        upsert_workflow_state(
            fake_get, fake_post, fake_delete,
            "db", "doc-1", "policy", "vector_indexed",
        )

        doc = writes[0]["document"]
        assert doc["ready_for_compliance"] is True

    def test_not_ready_when_missing_steps(self):
        writes: list[dict] = []

        def fake_get(endpoint, params):
            return {"documents": []}, None

        def fake_post(endpoint, payload):
            writes.append(payload)
            return {"ok": True}, None

        def fake_delete(endpoint, params):
            return None, None

        upsert_workflow_state(
            fake_get, fake_post, fake_delete,
            "db", "doc-1", "policy", "gathered",
        )

        doc = writes[0]["document"]
        assert doc["ready_for_compliance"] is False


# ── _missing_steps ────────────────────────────────────────────

class TestMissingSteps:
    def test_all_missing_when_none(self):
        assert _missing_steps(None) == list(WORKFLOW_STEPS)

    def test_all_missing_when_empty_steps(self):
        assert _missing_steps({"steps": {}}) == list(WORKFLOW_STEPS)

    def test_partial(self):
        state = {
            "steps": {
                "gathered": {"completed": True},
                "parsed": {"completed": False},
            }
        }
        missing = _missing_steps(state)
        assert "gathered" not in missing
        assert "parsed" in missing
        assert "vector_indexed" in missing


# ── assert_policy_ready_for_compliance ────────────────────────

class TestAssertPolicyReady:
    def test_returns_none_when_ready(self):
        state = {
            "document_id": "doc-1",
            "document_type": "policy",
            "steps": {
                "gathered": {"completed": True},
                "parsed": {"completed": True},
                "vector_indexed": {"completed": True},
            },
            "ready_for_compliance": True,
        }

        def fake_get(endpoint, params):
            return {"documents": [state]}, None

        result = assert_policy_ready_for_compliance(fake_get, "db", "doc-1")
        assert result is None

    def test_returns_error_when_not_ready(self):
        def fake_get(endpoint, params):
            return {"documents": []}, None

        result = assert_policy_ready_for_compliance(fake_get, "db", "doc-1")
        assert result is not None
        assert result["error"] == "document_not_ready"
        assert "missing_steps" in result
