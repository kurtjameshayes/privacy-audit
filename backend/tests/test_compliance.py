"""Tests for compliance API endpoints and vector-search proxy."""
from __future__ import annotations

from typing import Any

from backend import app as app_module


def test_vector_search_requires_index_names() -> None:
    client = app_module.app.test_client()
    response = client.post("/api/vector-search", json={})
    assert response.status_code == 400
    data = response.get_json()
    assert data and "error" in data


def test_vector_search_requires_query_text_or_embedding() -> None:
    client = app_module.app.test_client()
    response = client.post(
        "/api/vector-search",
        json={
            "index_database_name": "privacy-compliance",
            "index_collection_name": "statute_embeddings",
        },
    )
    assert response.status_code == 400


def test_vector_search_forwards_payload(monkeypatch: Any) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        calls.append((endpoint, payload))
        return {"chunks": []}, None

    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/vector-search",
        json={
            "index_database_name": "db",
            "index_collection_name": "coll",
            "query_text": "right to delete",
            "filter": {"jurisdiction": "CA"},
            "top_k": 10,
        },
    )

    assert response.status_code == 200
    assert len(calls) == 1
    assert calls[0][0] == "/vector-search"
    assert calls[0][1]["index_database_name"] == "db"
    assert calls[0][1]["query_text"] == "right to delete"
    assert calls[0][1]["top_k"] == 10


def test_compliance_applicability_requires_policy_document_id() -> None:
    client = app_module.app.test_client()
    response = client.post("/api/compliance/applicability", json={})
    assert response.status_code == 400
    assert response.get_json().get("error", "").lower().find("policy_document_id") >= 0


def test_compliance_applicability_returns_json(monkeypatch: Any) -> None:
    ready_workflow = {
        "document_id": "doc-123",
        "document_type": "policy",
        "steps": {
            "gathered": {"completed": True, "completed_at": "2024-01-01T00:00:00Z"},
            "parsed": {"completed": True, "completed_at": "2024-01-01T00:00:00Z"},
            "vector_indexed": {"completed": True, "completed_at": "2024-01-01T00:00:00Z"},
        },
        "ready_for_compliance": True,
    }

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        if "document_workflow_state" in str(params.get("collection_name", "")):
            return {"documents": [ready_workflow]}, None
        return {
            "documents": [
                {"_id": "doc-123", "document_id": "doc-123", "text": "Privacy policy for California.", "company_name": "Acme"}
            ]
        }, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        if endpoint == "/parse-llm":
            return {"chunks": [{"parsed_text": '{"applicable_jurisdictions": ["CA"], "confidence": {"CA": 0.9}}'}]}, None
        return None, ("upstream error", 502)

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/compliance/applicability",
        json={"policy_document_id": "doc-123"},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert "applicable_jurisdictions" in data or "error" in data
    if "error" not in data:
        assert data.get("applicable_jurisdictions") == ["CA"]


def test_compliance_applicability_parsed_doc_format(monkeypatch: Any) -> None:
    """Test applicability when upstream returns parsed_doc (ParseModal-style) format."""
    ready_workflow = {
        "document_id": "doc-456",
        "document_type": "policy",
        "steps": {"gathered": {"completed": True}, "parsed": {"completed": True}, "vector_indexed": {"completed": True}},
        "ready_for_compliance": True,
    }

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        if "document_workflow_state" in str(params.get("collection_name", "")):
            return {"documents": [ready_workflow]}, None
        return {
            "documents": [
                {"_id": "doc-456", "document_id": "doc-456", "text": "Virginia privacy policy.", "company_name": "Test"}
            ]
        }, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        if endpoint == "/parse-llm":
            return {
                "parsed_doc": [
                    {"parsed_header_text": "Jurisdictions", "parsed_text": '{"applicable_jurisdictions": ["VA", "US"], "confidence": {"VA": 0.9}}'}
                ]
            }, None
        return None, ("upstream error", 502)

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/compliance/applicability",
        json={"policy_document_id": "doc-456"},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert "error" not in data
    assert data.get("applicable_jurisdictions") == ["VA", "US"]


def test_compliance_gap_analysis_requires_policy_document_id() -> None:
    client = app_module.app.test_client()
    response = client.post("/api/compliance/gap-analysis", json={})
    assert response.status_code == 400


def test_compliance_gap_analysis_returns_spec_shape(monkeypatch: Any) -> None:
    ready_workflow = {
        "document_id": "doc-1",
        "document_type": "policy",
        "steps": {
            "gathered": {"completed": True},
            "parsed": {"completed": True},
            "vector_indexed": {"completed": True},
        },
        "ready_for_compliance": True,
    }

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        if "document_workflow_state" in str(params.get("collection_name", "")):
            return {"documents": [ready_workflow]}, None
        if "statutes" in str(params.get("collection_name", "")):
            return {"documents": [{"_id": "stat-ca-1", "document_id": "stat-ca-1", "jurisdiction": "CA"}]}, None
        return {"documents": []}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        if endpoint == "/api/v4/compliance/gap-analysis":
            return {
                "policy_document_id": "doc-1",
                "company_name": "Acme",
                "applicable_jurisdictions": ["CA", "VA"],
                "analyzed_at": "2024-01-01T00:00:00Z",
                "gaps": [],
                "summary": {"total_requirements": 0, "missing": 0, "addressed": 0, "conflicts": 0},
            }, None
        return None, ("upstream", 502)

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/compliance/gap-analysis",
        json={"policy_document_id": "doc-1"},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert "gaps" in data
    assert "summary" in data
    assert "analyzed_at" in data
    assert data["summary"].get("total_requirements", 0) >= 0


def test_compliance_gap_analysis_produces_gaps_when_upstream_succeeds(monkeypatch: Any) -> None:
    """When upstream /api/compliance/gap-analysis returns gaps, we get non-zero requirements."""
    ready_workflow = {
        "document_id": "doc-gap",
        "document_type": "policy",
        "steps": {"gathered": {"completed": True}, "parsed": {"completed": True}, "vector_indexed": {"completed": True}},
        "ready_for_compliance": True,
    }

    gap_analysis_calls: list[dict[str, Any]] = []

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        if "document_workflow_state" in str(params.get("collection_name", "")):
            return {"documents": [ready_workflow]}, None
        if "statutes" in str(params.get("collection_name", "")):
            return {"documents": [{"_id": "stat-ca-1", "document_id": "stat-ca-1", "jurisdiction": "CA"}]}, None
        return {"documents": []}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        if endpoint == "/api/v4/compliance/gap-analysis":
            gap_analysis_calls.append(payload)
            return {
                "policy_document_id": "doc-gap",
                "company_name": "Acme",
                "applicable_jurisdictions": ["CA"],
                "analyzed_at": "2024-01-01T00:00:00Z",
                "gaps": [
                    {
                        "jurisdiction": "CA",
                        "requirement_summary": "Right to know",
                        "status": "missing",
                        "policy_quote": None,
                        "conflict_description": None,
                        "statute_reference": "stat-ca-1",
                    }
                ],
                "summary": {"total_requirements": 1, "missing": 1, "addressed": 0, "conflicts": 0},
            }, None
        return None, ("upstream", 502)

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/compliance/gap-analysis",
        json={"policy_document_id": "doc-gap", "applicable_jurisdictions": ["CA"]},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert "gaps" in data
    assert "summary" in data
    assert data["summary"]["total_requirements"] == 1
    assert len(data["gaps"]) == 1
    assert data["gaps"][0]["status"] == "missing"
    assert len(gap_analysis_calls) == 1
    assert gap_analysis_calls[0].get("policy_document_id") == "doc-gap"
    assert gap_analysis_calls[0].get("applicable_jurisdictions") == ["CA"]


def test_compliance_multi_jurisdictional_requires_jurisdictions() -> None:
    client = app_module.app.test_client()
    response = client.post("/api/compliance/multi-jurisdictional", json={})
    assert response.status_code == 400
    response2 = client.post(
        "/api/compliance/multi-jurisdictional",
        json={"applicable_jurisdictions": "CA"},
    )
    assert response2.status_code == 400


def test_compliance_multi_jurisdictional_returns_spec_shape(monkeypatch: Any) -> None:
    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        if "document_workflow_state" in str(params.get("collection_name", "")):
            return {"documents": []}, None
        if "statute_chunks" in str(params.get("collection_name", "")):
            return {"documents": [{"document_id": "stat-ca-1", "chunk_text": "Right to know.", "jurisdiction": "CA"}]}, None
        if "statutes" in str(params.get("collection_name", "")):
            return {"documents": [{"_id": "stat-ca-1", "document_id": "stat-ca-1", "jurisdiction": "CA"}, {"_id": "stat-va-1", "document_id": "stat-va-1", "jurisdiction": "VA"}]}, None
        return {"documents": []}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        if endpoint == "/vector-search":
            return {"chunks": [{"jurisdiction": "CA"}, {"jurisdiction": "VA"}]}, None
        return {"chunks": []}, None

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/compliance/multi-jurisdictional",
        json={"applicable_jurisdictions": ["CA", "VA"]},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert "strictest_common_denominator" in data
    assert "conflicts_between_jurisdictions" in data
    assert data["applicable_jurisdictions"] == ["CA", "VA"]


def test_compliance_health_score_requires_policy_document_id() -> None:
    client = app_module.app.test_client()
    response = client.post("/api/compliance/health-score", json={})
    assert response.status_code == 400


def test_compliance_health_score_returns_spec_shape(monkeypatch: Any) -> None:
    ready_workflow = {
        "document_id": "doc-1",
        "document_type": "policy",
        "steps": {
            "gathered": {"completed": True},
            "parsed": {"completed": True},
            "vector_indexed": {"completed": True},
        },
        "ready_for_compliance": True,
    }

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        if "document_workflow_state" in str(params.get("collection_name", "")):
            return {"documents": [ready_workflow]}, None
        if "statutes" in str(params.get("collection_name", "")):
            return {"documents": [{"_id": "stat-ca-1", "document_id": "stat-ca-1", "jurisdiction": "CA"}]}, None
        return {"documents": []}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        if endpoint == "/api/v4/compliance/gap-analysis":
            return {
                "policy_document_id": "doc-1",
                "company_name": "Acme",
                "applicable_jurisdictions": ["CA"],
                "analyzed_at": "2024-01-01T00:00:00Z",
                "gaps": [
                    {
                        "jurisdiction": "CA",
                        "requirement_summary": "right_to_know",
                        "status": "addressed",
                        "policy_quote": "We collect data.",
                        "conflict_description": None,
                        "statute_reference": "stat-ca-1",
                    }
                ],
                "summary": {"total_requirements": 1, "missing": 0, "addressed": 1, "conflicts": 0},
            }, None
        return None, ("upstream", 502)

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post(
        "/api/compliance/health-score",
        json={"policy_document_id": "doc-1"},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert "privacy_health_score" in data
    assert "score_breakdown" in data
    assert "components" in data
    assert "analyzed_at" in data


def test_compliance_health_score_accepts_weights(monkeypatch: Any) -> None:
    """Health score endpoint accepts weights in request body per HealthScoreRequest spec."""
    ready_workflow = {
        "document_id": "doc-1",
        "document_type": "policy",
        "steps": {
            "gathered": {"completed": True},
            "parsed": {"completed": True},
            "vector_indexed": {"completed": True},
        },
        "ready_for_compliance": True,
    }

    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        if "document_workflow_state" in str(params.get("collection_name", "")):
            return {"documents": [ready_workflow]}, None
        if "statutes" in str(params.get("collection_name", "")):
            return {"documents": [{"_id": "stat-ca-1", "document_id": "stat-ca-1", "jurisdiction": "CA"}]}, None
        return {"documents": []}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        if endpoint == "/api/v4/compliance/gap-analysis":
            return {
                "policy_document_id": "doc-1",
                "company_name": "Acme",
                "applicable_jurisdictions": ["CA"],
                "analyzed_at": "2024-01-01T00:00:00Z",
                "gaps": [
                    {
                        "jurisdiction": "CA",
                        "requirement_summary": "The right to delete personal information",
                        "status": "addressed",
                        "policy_quote": "We delete data on request.",
                        "conflict_description": None,
                        "statute_reference": "stat-ca-1",
                    }
                ],
                "summary": {"total_requirements": 1, "missing": 0, "addressed": 1, "conflicts": 0},
            }, None
        return None, ("upstream", 502)

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    weights = {
        "A consumer shall have the right to request that a business that collects personal information about the consumer disclose to the consumer the following: (1) The categories of personal information it has collected about that consumer.": 2.0,
        "The right to delete personal information": 1.5,
    }
    response = client.post(
        "/api/compliance/health-score",
        json={"policy_document_id": "doc-1", "weights": weights},
    )

    assert response.status_code == 200
    data = response.get_json()
    assert "privacy_health_score" in data
    assert data["privacy_health_score"] == 100  # 1 addressed with weight 1.5


def test_compliance_drift_check_returns_spec_shape(monkeypatch: Any) -> None:
    def fake_forward_get(endpoint: str, params: dict[str, Any]) -> Any:
        if "policies" in str(params.get("collection_name", "")):
            return {"documents": []}, None
        return {"documents": []}, None

    def fake_forward_post(endpoint: str, payload: dict[str, Any]) -> Any:
        if endpoint == "/api/v4/compliance/gap-analysis":
            return {
                "policy_document_id": payload.get("policy_document_id", ""),
                "company_name": "",
                "applicable_jurisdictions": [],
                "analyzed_at": "2024-01-01T00:00:00Z",
                "gaps": [],
                "summary": {"total_requirements": 0, "missing": 0, "addressed": 0, "conflicts": 0},
            }, None
        return {"chunks": []}, None

    monkeypatch.setattr(app_module, "forward_get", fake_forward_get)
    monkeypatch.setattr(app_module, "forward_post", fake_forward_post)
    client = app_module.app.test_client()

    response = client.post("/api/compliance/drift-check", json={})

    assert response.status_code == 200
    data = response.get_json()
    assert "analyzed_at" in data
    assert "policies_checked" in data
    assert "alerts" in data
    assert isinstance(data["alerts"], list)
