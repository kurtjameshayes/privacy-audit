"""Integration tests for compliance routes: stale sweep, runs filtering, run detail, _is_valid_id."""
from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta
from typing import Any

import pytest

from backend import app as app_module
from backend.routes import compliance as comp_module
from backend.routes.compliance import _is_valid_id, _normalize_gap_summary


@pytest.fixture()
def client():
    app_module.app.config["TESTING"] = True
    with app_module.app.test_client() as c:
        yield c


# ── _is_valid_id ──────────────────────────────────────────────

class TestIsValidId:
    def test_valid_uuid(self):
        assert _is_valid_id("550e8400-e29b-41d4-a716-446655440000") is True

    def test_valid_objectid(self):
        assert _is_valid_id("507f1f77bcf86cd799439011") is True

    def test_rejects_short_string(self):
        assert _is_valid_id("abc") is False

    def test_rejects_long_garbage(self):
        assert _is_valid_id("x" * 50) is False

    def test_rejects_injection_attempt(self):
        assert _is_valid_id("507f1f77bcf86cd799439011; DROP TABLE") is False

    def test_rejects_empty(self):
        assert _is_valid_id("") is False

    def test_rejects_dashes_only(self):
        assert _is_valid_id("----" * 8) is False

    def test_uuid_v4(self):
        import uuid
        assert _is_valid_id(str(uuid.uuid4())) is True


# ── _normalize_gap_summary ────────────────────────────────────

class TestNormalizeGapSummary:
    def test_computes_from_gaps(self):
        gaps = [
            {"status": "addressed"},
            {"status": "partial"},
            {"status": "ambiguous"},
            {"status": "missing"},
            {"status": "conflict"},
        ]
        result = _normalize_gap_summary(gaps, None)
        assert result["total_requirements"] == 5
        assert result["addressed"] == 1
        assert result["partial"] == 1
        assert result["ambiguous"] == 1
        assert result["missing"] == 1
        assert result["conflicts"] == 1

    def test_empty_gaps_preserves_existing(self):
        existing = {"total_requirements": 10}
        result = _normalize_gap_summary([], existing)
        assert result["total_requirements"] == 10
        assert result["partial"] == 0
        assert result["ambiguous"] == 0


# ── stale job sweep ───────────────────────────────────────────

class TestStaleSweep:
    def test_sweeps_old_pending_jobs(self, client, monkeypatch):
        old_time = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        writes: list[dict] = []

        def fake_fetch(collection, query=None, limit=None):
            if query and query.get("status") == "pending":
                return [{"job_id": "old-job", "status": "pending", "created_at": old_time}]
            return []

        def fake_post(endpoint, payload):
            writes.append(payload)
            return {"ok": True}, None

        def fake_delete(endpoint, params):
            return None, None

        monkeypatch.setattr(comp_module, "_fetch_documents", fake_fetch)
        monkeypatch.setattr(comp_module, "forward_post", fake_post)
        monkeypatch.setattr(comp_module, "forward_delete", fake_delete)

        resp = client.post("/api/compliance/jobs/sweep-stale")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["swept"] == 1

    def test_does_not_sweep_recent_jobs(self, client, monkeypatch):
        recent_time = datetime.now(timezone.utc).isoformat()

        def fake_fetch(collection, query=None, limit=None):
            if query and query.get("status") == "pending":
                return [{"job_id": "new-job", "status": "pending", "created_at": recent_time}]
            return []

        monkeypatch.setattr(comp_module, "_fetch_documents", fake_fetch)

        resp = client.post("/api/compliance/jobs/sweep-stale")
        assert resp.status_code == 200
        assert resp.get_json()["swept"] == 0


# ── compliance runs filtering ─────────────────────────────────

class TestComplianceRunsFiltering:
    @staticmethod
    def _make_fetch(jobs_data: list[dict]):
        """Return a _fetch_documents mock that only populates the jobs collection."""
        def fake_fetch(collection, query=None, limit=None):
            if collection == comp_module.COMPLIANCE_JOBS_COLLECTION:
                return jobs_data
            return []
        return fake_fetch

    def test_filters_by_policy_document_id(self, client, monkeypatch):
        jobs = [
            {
                "job_id": "j1",
                "job_type": "gap_analysis",
                "request": {"policy_document_id": "p1"},
                "result": {},
                "status": "completed",
                "created_at": "2024-01-01T00:00:00Z",
            },
            {
                "job_id": "j2",
                "job_type": "gap_analysis",
                "request": {"policy_document_id": "p2"},
                "result": {},
                "status": "completed",
                "created_at": "2024-01-02T00:00:00Z",
            },
        ]

        monkeypatch.setattr(comp_module, "_fetch_documents", self._make_fetch(jobs))

        resp = client.get("/api/compliance/runs", query_string={"policy_document_id": "p1"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["total"] == 1
        assert data["runs"][0]["policy_document_id"] == "p1"

    def test_filters_by_types(self, client, monkeypatch):
        jobs = [
            {
                "job_id": "j1",
                "job_type": "gap_analysis",
                "request": {},
                "result": {},
                "status": "completed",
                "created_at": "2024-01-01T00:00:00Z",
            },
            {
                "job_id": "j2",
                "job_type": "health_score",
                "request": {},
                "result": {},
                "status": "completed",
                "created_at": "2024-01-01T00:00:00Z",
            },
        ]

        monkeypatch.setattr(comp_module, "_fetch_documents", self._make_fetch(jobs))

        resp = client.get("/api/compliance/runs", query_string={"types": "health_score"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["total"] == 1
        assert data["runs"][0]["job_type"] == "health_score"

    def test_pagination(self, client, monkeypatch):
        jobs = [
            {
                "job_id": f"j{i}",
                "job_type": "gap_analysis",
                "request": {},
                "result": {},
                "status": "completed",
                "created_at": f"2024-01-{i+1:02d}T00:00:00Z",
            }
            for i in range(5)
        ]

        monkeypatch.setattr(comp_module, "_fetch_documents", self._make_fetch(jobs))

        resp = client.get("/api/compliance/runs", query_string={"limit": "2", "offset": "0"})
        data = resp.get_json()
        assert data["total"] == 5
        assert len(data["runs"]) == 2

        resp2 = client.get("/api/compliance/runs", query_string={"limit": "2", "offset": "2"})
        data2 = resp2.get_json()
        assert len(data2["runs"]) == 2
        assert data2["runs"][0]["run_id"] != data["runs"][0]["run_id"]


# ── run detail ────────────────────────────────────────────────

class TestRunDetail:
    def test_invalid_id_rejected(self, client):
        resp = client.get("/api/compliance/runs/not-a-valid-id!")
        assert resp.status_code == 400

    def test_valid_uuid_accepted(self, client, monkeypatch):
        def fake_get(endpoint, params):
            return {"documents": []}, None

        monkeypatch.setattr(comp_module, "forward_get", fake_get)

        resp = client.get("/api/compliance/runs/550e8400-e29b-41d4-a716-446655440000")
        assert resp.status_code == 404

    def test_returns_run_when_found(self, client, monkeypatch):
        job_doc = {
            "_id": "507f1f77bcf86cd799439011",
            "job_id": "507f1f77bcf86cd799439011",
            "job_type": "gap_analysis",
            "status": "completed",
            "request": {"policy_document_id": "p1"},
            "result": {
                "gaps": [{"status": "addressed"}],
                "policy_document_id": "p1",
            },
            "created_at": "2024-01-01T00:00:00Z",
        }

        def fake_get(endpoint, params):
            query_raw = params.get("query")
            if query_raw:
                q = json.loads(query_raw)
                if q.get("job_id") == "507f1f77bcf86cd799439011":
                    return {"documents": [job_doc]}, None
            return {"documents": []}, None

        monkeypatch.setattr(comp_module, "forward_get", fake_get)

        resp = client.get("/api/compliance/runs/507f1f77bcf86cd799439011")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["job_type"] == "gap_analysis"


# ── compliance job creation guards ────────────────────────────

class TestComplianceJobCreation:
    def test_requires_job_type(self, client):
        resp = client.post("/api/compliance/jobs", json={"policy_document_id": "p1"})
        assert resp.status_code == 400

    def test_requires_policy_document_id(self, client):
        resp = client.post("/api/compliance/jobs", json={"job_type": "gap_analysis"})
        assert resp.status_code == 400

    def test_rejects_unsupported_job_type(self, client):
        resp = client.post(
            "/api/compliance/jobs",
            json={"job_type": "evil", "policy_document_id": "p1"},
        )
        assert resp.status_code == 400

    def test_returns_409_when_policy_not_ready(self, client, monkeypatch):
        def fake_get(endpoint, params):
            return {"documents": []}, None

        monkeypatch.setattr(comp_module, "forward_get", fake_get)

        resp = client.post(
            "/api/compliance/jobs",
            json={"job_type": "gap_analysis", "policy_document_id": "p1"},
        )
        assert resp.status_code == 409

    def test_multi_jurisdictional_requires_jurisdictions(self, client, monkeypatch):
        ready = {
            "document_id": "p1",
            "document_type": "policy",
            "steps": {
                "gathered": {"completed": True},
                "parsed": {"completed": True},
                "vector_indexed": {"completed": True},
            },
            "ready_for_compliance": True,
        }

        def fake_get(endpoint, params):
            if "workflow" in str(params.get("collection_name", "")):
                return {"documents": [ready]}, None
            return {"documents": []}, None

        monkeypatch.setattr(comp_module, "forward_get", fake_get)

        resp = client.post(
            "/api/compliance/jobs",
            json={"job_type": "multi_jurisdictional", "policy_document_id": "p1"},
        )
        assert resp.status_code == 400
        assert "jurisdictions" in resp.get_json()["error"].lower()


# ── compliance alerts ─────────────────────────────────────────

class TestComplianceAlerts:
    def test_alerts_forwards_params(self, client, monkeypatch):
        captured: list[dict] = []

        def fake_get(endpoint, params):
            captured.append(params)
            return {"alerts": [], "total": 0, "limit": 50, "offset": 0}, None

        monkeypatch.setattr(comp_module, "forward_get", fake_get)

        resp = client.get(
            "/api/compliance/alerts",
            query_string={"company_name": "Acme", "limit": "10"},
        )
        assert resp.status_code == 200
        assert captured[0].get("company_name") == "Acme"
        assert captured[0].get("limit") == "10"
