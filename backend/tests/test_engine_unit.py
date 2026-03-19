"""Unit tests for backend/compliance/engine.py: health score, applicability, helpers."""
from __future__ import annotations

from typing import Any

from backend.compliance.engine import (
    run_health_score,
    _extract_json_from_llm_response,
    _extract_json_array_from_llm_response,
    _clean_requirement_text,
    _normalize_category_name,
    _infer_chunk_category,
    _normalize_conflict,
    _normalize_validation_result,
    load_config,
)


# ── Health score: partial / ambiguous fractional credit ───────

class TestHealthScorePartialAmbiguous:
    def _run_score(self, statuses: list[str]) -> dict[str, Any]:
        gaps = [
            {"jurisdiction": "CA", "requirement_summary": f"req_{i}", "status": s}
            for i, s in enumerate(statuses)
        ]
        gap_result = {
            "policy_document_id": "p1",
            "company_name": "Acme",
            "applicable_jurisdictions": ["CA"],
            "gaps": gaps,
        }

        def noop_post(endpoint, payload):
            return None, ("unused", 500)

        def noop_get(endpoint, params):
            return {"documents": []}, None

        return run_health_score(
            noop_post, noop_get,
            "db", "policies", "policy_chunks", "statutes", "statute_chunks",
            "p1",
            gap_result=gap_result,
        )

    def test_all_addressed_is_100(self):
        result = self._run_score(["addressed", "addressed"])
        assert result["privacy_health_score"] == 100

    def test_all_missing_is_0(self):
        result = self._run_score(["missing", "missing"])
        assert result["privacy_health_score"] == 0

    def test_partial_scores_50_percent(self):
        result = self._run_score(["partial", "partial"])
        assert result["privacy_health_score"] == 50

    def test_ambiguous_scores_25_percent(self):
        result = self._run_score(["ambiguous", "ambiguous"])
        assert result["privacy_health_score"] == 25

    def test_mixed_statuses(self):
        result = self._run_score(["addressed", "partial", "ambiguous", "missing"])
        expected = round(100 * (1.0 + 0.5 + 0.25 + 0.0) / 4)
        assert result["privacy_health_score"] == expected

    def test_conflict_penalty_applies(self):
        result = self._run_score(["addressed", "conflict"])
        raw = (1.0 + 0.0) / 2
        penalized = raw * 0.7
        assert result["privacy_health_score"] == round(100 * penalized)
        assert result["components"]["conflict_penalty_applied"] is True

    def test_components_include_partial_ambiguous_counts(self):
        result = self._run_score(["addressed", "partial", "ambiguous", "missing", "conflict"])
        c = result["components"]
        assert c["addressed"] == 1
        assert c["partial"] == 1
        assert c["ambiguous"] == 1
        assert c["missing"] == 1
        assert c["conflicts"] == 1
        assert c["requirements_total"] == 5

    def test_no_gaps_returns_none_score(self):
        result = self._run_score([])
        assert result["privacy_health_score"] is None
        assert result.get("error") == "no_applicable_statutes"


# ── _extract_json_from_llm_response ───────────────────────────

class TestExtractJsonFromLLM:
    def test_extracts_from_code_block(self):
        response = {"chunks": [{"parsed_text": '```json\n{"applicable_jurisdictions": ["CA"]}\n```'}]}
        result = _extract_json_from_llm_response(response)
        assert result is not None
        assert result["applicable_jurisdictions"] == ["CA"]

    def test_extracts_from_raw_json(self):
        response = {"raw": '{"applicable_jurisdictions": ["VA", "CO"], "confidence": {}}'}
        result = _extract_json_from_llm_response(response)
        assert result is not None
        assert "VA" in result["applicable_jurisdictions"]

    def test_returns_none_for_garbage(self):
        result = _extract_json_from_llm_response("not json at all")
        assert result is None

    def test_direct_dict_passthrough(self):
        data = {"applicable_jurisdictions": ["CA"]}
        result = _extract_json_from_llm_response(data)
        assert result == data

    def test_gap_check_format(self):
        response = [{"parsed_text": '{"addressed": "yes", "missing": "no"}'}]
        result = _extract_json_from_llm_response(response)
        assert result is not None
        assert result.get("addressed") == "yes"


class TestExtractJsonArrayFromLLM:
    def test_extracts_array(self):
        response = {"chunks": [{"parsed_text": '[{"conflict_id": "c1"}]'}]}
        result = _extract_json_array_from_llm_response(response)
        assert result is not None
        assert len(result) == 1
        assert result[0]["conflict_id"] == "c1"

    def test_extracts_from_code_block(self):
        response = {"chunks": [{"parsed_text": '```json\n[{"id": 1}]\n```'}]}
        result = _extract_json_array_from_llm_response(response)
        assert result is not None
        assert len(result) == 1

    def test_returns_none_for_non_array(self):
        result = _extract_json_array_from_llm_response({"raw": "not json"})
        assert result is None


# ── _clean_requirement_text ───────────────────────────────────

class TestCleanRequirementText:
    def test_normalizes_whitespace(self):
        assert _clean_requirement_text("  hello   world  ") == "hello world"

    def test_truncates(self):
        result = _clean_requirement_text("x" * 2000, max_len=100)
        assert len(result) == 100

    def test_empty(self):
        assert _clean_requirement_text("") == ""
        assert _clean_requirement_text(None) == ""


# ── _normalize_category_name ─────────────────────────────────

class TestNormalizeCategoryName:
    def test_exact_match(self):
        configured = ["right to know", "right to delete"]
        assert _normalize_category_name("right to know", configured) == "right to know"

    def test_case_insensitive(self):
        configured = ["Right To Know"]
        assert _normalize_category_name("right to know", configured) == "Right To Know"

    def test_partial_match(self):
        configured = ["sale of data"]
        assert _normalize_category_name("sale of data processing", configured) == "sale of data"

    def test_unknown_returns_value(self):
        assert _normalize_category_name("obscure category", []) == "obscure category"

    def test_empty_returns_other(self):
        assert _normalize_category_name("", []) == "other"


# ── _infer_chunk_category ────────────────────────────────────

class TestInferChunkCategory:
    def test_uses_explicit_category(self):
        chunk = {"category": "right to delete", "chunk_text": "anything"}
        assert _infer_chunk_category(chunk, ["right to delete"]) == "right to delete"

    def test_infers_from_text(self):
        chunk = {"chunk_header_text": "Right to Delete Personal Data", "chunk_text": "The consumer may delete..."}
        result = _infer_chunk_category(chunk, ["right to delete", "sale of data"])
        assert "delete" in result.lower()

    def test_returns_other_when_no_match(self):
        chunk = {"chunk_text": "lorem ipsum"}
        assert _infer_chunk_category(chunk, ["right to delete"]) == "other"


# ── _normalize_conflict / _normalize_validation_result ────────

class TestNormalizeConflict:
    def test_fills_defaults(self):
        raw = {"description": "A conflict"}
        result = _normalize_conflict(raw, "cat", "CA", "VA", 1)
        assert result["conflict_id"] == "cat_CA_VA_1"
        assert result["conflict_type"] == "OTHER"
        assert result["severity"] == "LOW"
        assert result["category"] == "cat"

    def test_preserves_valid_type_and_severity(self):
        raw = {
            "conflict_type": "RETENTION_VS_DELETION",
            "severity": "HIGH",
        }
        result = _normalize_conflict(raw, "cat", "CA", "VA", 1)
        assert result["conflict_type"] == "RETENTION_VS_DELETION"
        assert result["severity"] == "HIGH"

    def test_invalid_type_defaults_to_other(self):
        raw = {"conflict_type": "INVALID_TYPE"}
        result = _normalize_conflict(raw, "cat", "CA", "VA", 1)
        assert result["conflict_type"] == "OTHER"


class TestNormalizeValidationResult:
    def test_confirmed(self):
        raw = {"conflict_id": "c1", "verdict": "CONFIRMED", "reasoning": "real"}
        result = _normalize_validation_result("c1", raw)
        assert result["verdict"] == "CONFIRMED"

    def test_false_positive(self):
        raw = {"conflict_id": "c1", "verdict": "FALSE_POSITIVE", "reasoning": "not real"}
        result = _normalize_validation_result("c1", raw)
        assert result["verdict"] == "FALSE_POSITIVE"

    def test_none_input(self):
        result = _normalize_validation_result("c1", None)
        assert result["verdict"] == "CONFIRMED"
        assert "could not be parsed" in result["reasoning"]

    def test_invalid_verdict_defaults_confirmed(self):
        raw = {"verdict": "MAYBE"}
        result = _normalize_validation_result("c1", raw)
        assert result["verdict"] == "CONFIRMED"


# ── load_config ───────────────────────────────────────────────

class TestLoadConfig:
    def test_returns_defaults_when_file_missing(self):
        config = load_config("/nonexistent/path.json")
        assert "default_jurisdictions" in config
        assert isinstance(config["default_jurisdictions"], list)
