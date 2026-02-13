"""
Integration tests for compliance gap analysis against the real upstream parse-llm API.

Skips when GATHER_API_BASE_URL or FIRECRAWL_API_KEY is not set.
Requires: a policy document and at least one statute with chunks in the configured DB.

Run with: pytest backend/tests/test_compliance_integration.py -v

Note: This test may take 2-5 minutes as it runs real LLM calls against the upstream.
Set COMPLIANCE_TEST_POLICY_ID to use a specific policy document (default from env).
"""
from __future__ import annotations

import os

import pytest

from backend import app as app_module
from dotenv import load_dotenv

# Load .env so GATHER_API_BASE_URL and FIRECRAWL_API_KEY are available
_project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
load_dotenv(os.path.join(_project_root, ".env"), override=True)

REQUIRES_UPSTREAM = not (
    os.getenv("GATHER_API_BASE_URL", "").strip()
    and os.getenv("FIRECRAWL_API_KEY", "").strip()
)


@pytest.mark.skipif(REQUIRES_UPSTREAM, reason="GATHER_API_BASE_URL and FIRECRAWL_API_KEY must be set")
def test_gap_analysis_produces_results_with_real_upstream() -> None:
    """Run gap analysis against real upstream; assert we get non-zero requirements."""
    policy_id = os.getenv(
        "COMPLIANCE_TEST_POLICY_ID",
        "142bcbe4-f34b-4f60-8be3-79ed269375ab",
    ).strip()
    client = app_module.app.test_client()

    response = client.post(
        "/api/compliance/gap-analysis",
        json={
            "policy_document_id": policy_id,
            "applicable_jurisdictions": ["CA"],
            "save_results": False,
        },
    )

    assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.get_data(as_text=True)}"
    data = response.get_json()
    assert data is not None

    error = data.get("error")
    assert error is None, (
        f"Gap analysis returned error: {error}. "
        "Ensure policy and statute chunks exist for the test policy and jurisdiction CA."
    )

    summary = data.get("summary", {})
    total = summary.get("total_requirements", 0)
    assert total > 0, f"Expected total_requirements > 0, got {total}"

    gaps = data.get("gaps", [])
    assert len(gaps) > 0, "Expected non-empty gaps list"
