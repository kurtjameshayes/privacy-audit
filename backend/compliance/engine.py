"""
Compliance analysis engine: applicability, gap analysis, multi-jurisdictional,
health score, regulatory drift. Zero-human-touch; uses SLM and heuristics only.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from itertools import combinations
from datetime import datetime, timezone
from typing import Any, Callable

from backend.utils import get_documents as _get_documents_shared

# Default config path relative to backend/
DEFAULT_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "compliance_config.json")
CONFLICT_TYPES = {
    "RETENTION_VS_DELETION",
    "CONSENT_MODEL",
    "NOTICE_TIMING",
    "OPT_OUT_SCOPE",
    "DATA_SCOPE_DEFINITION",
    "ENFORCEMENT_MECHANISM",
    "AGE_THRESHOLD",
    "EXEMPTION_BOUNDARY",
    "OTHER",
}
SEVERITY_LEVELS = {"HIGH", "MEDIUM", "LOW"}
VALIDATION_VERDICTS = {"CONFIRMED", "FALSE_POSITIVE", "DOWNGRADE"}


def load_config(path: str | None = None) -> dict[str, Any]:
    """Load compliance config JSON. Returns dict with default_jurisdictions, canonical_requirement_ids, etc."""
    p = path or DEFAULT_CONFIG_PATH
    if not os.path.isfile(p):
        return {
            "default_jurisdictions": ["CA", "VA", "CO", "CT"],
            "canonical_requirement_ids": ["right_to_know", "right_to_delete", "opt_out_of_sale"],
            "requirement_weights": {},
            "category_mapping": {},
            "disclosure_query_categories": ["right to know", "right to delete", "sale of data", "sensitive data"],
            "health_score": {"conflict_penalty_multiplier": 0.7, "default_weight": 1.0},
        }
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def _extract_document_id(doc: dict[str, Any]) -> str:
    """Get string document id from document record (e.g. _id or document_id)."""
    if doc.get("document_id"):
        return str(doc["document_id"])
    if doc.get("_id"):
        return str(doc["_id"])
    return ""


def _get_documents(
    forward_get: Callable[..., tuple[Any, Any]],
    database_name: str,
    collection_name: str,
    query: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    return _get_documents_shared(forward_get, database_name, collection_name, query)


def _parse_llm(
    forward_post: Callable[..., tuple[Any, Any]],
    database_name: str,
    collection_name: str,
    document_id: str,
    prompt: str,
) -> tuple[Any, Any]:
    """Call parse-llm and return (parsed_response, error)."""
    return forward_post(
        "/parse-llm",
        {
            "database": database_name,
            "collection": collection_name,
            "parse_prompt": prompt,
            "document_id": document_id,
            "database_name": database_name,
            "collection_name": collection_name,
            "prompt": prompt,
        },
    )


def _gap_check_via_upstream(
    forward_post: Callable[..., tuple[Any, Any]],
    database_name: str,
    policy_collection: str,
    policy_document_id: str,
    statute_chunk_collection: str,
    statute_chunk_id: str,
    max_policy_chars: int = 8000,
) -> tuple[Any, Any]:
    """Call upstream /gap-check and return (response, error)."""
    return forward_post(
        "/gap-check",
        {
            "policy_database_name": database_name,
            "policy_collection_name": policy_collection,
            "policy_document_id": policy_document_id,
            "statute_database_name": database_name,
            "statute_collection_name": statute_chunk_collection,
            "statute_document_id": statute_chunk_id,
            "max_policy_chars": max_policy_chars,
        },
    )


def _extract_json_from_llm_response(response: Any) -> dict[str, Any] | None:
    """Parse LLM response (chunks or raw) and extract a single JSON object."""
    if isinstance(response, dict) and "applicable_jurisdictions" in response:
        return response
    text = ""
    if isinstance(response, list):
        for item in response:
            if isinstance(item, dict):
                text += str(item.get("parsed_text", item.get("chunk_text", item.get("text", ""))))
            else:
                text += str(item)
    elif isinstance(response, dict):
        chunks = response.get("chunks", response.get("documents", response.get("results", response.get("parsed_doc"))))
        if isinstance(chunks, list):
            for item in chunks:
                if isinstance(item, dict):
                    text += str(item.get("parsed_text", item.get("chunk_text", item.get("text", ""))))
        else:
            text = str(response.get("raw", response.get("text", "")))
    else:
        text = str(response)
    # Strip markdown code blocks if present
    code_block = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text)
    if code_block:
        try:
            return json.loads(code_block.group(1))
        except json.JSONDecodeError:
            pass
    # Try to find JSON object containing applicable_jurisdictions
    if "applicable_jurisdictions" in text:
        match = re.search(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", text, re.DOTALL)
        if match:
            try:
                parsed = json.loads(match.group(0))
                if "applicable_jurisdictions" in parsed:
                    return parsed
            except json.JSONDecodeError:
                pass
        # Try matching from first { to last } (handles nested braces)
        start = text.find("{")
        if start >= 0:
            depth, end = 0, start
            for i, c in enumerate(text[start:], start):
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        end = i
                        break
            if depth == 0:
                try:
                    return json.loads(text[start : end + 1])
                except json.JSONDecodeError:
                    pass
    # Generic brace-matching for gap-check JSON (addressed, missing, conflict)
    if any(k in text for k in ("addressed", "missing", "conflict")):
        start = text.find("{")
        if start >= 0:
            depth, end = 0, start
            for i, c in enumerate(text[start:], start):
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        end = i
                        break
            if depth == 0:
                try:
                    parsed = json.loads(text[start : end + 1])
                    if any(parsed.get(k) is not None for k in ("addressed", "missing", "conflict")):
                        return parsed
                except json.JSONDecodeError:
                    pass
    try:
        parsed = json.loads(text.strip())
        if not isinstance(parsed, dict):
            return None
        if "applicable_jurisdictions" in parsed:
            return parsed
        if any(parsed.get(k) is not None for k in ("addressed", "missing", "conflict")):
            return parsed
        return None
    except json.JSONDecodeError:
        return None


def _response_to_text(response: Any) -> str:
    """Flatten mixed upstream response shape into one text blob."""
    text = ""
    if isinstance(response, list):
        for item in response:
            if isinstance(item, dict):
                text += str(item.get("parsed_text", item.get("chunk_text", item.get("text", ""))))
            else:
                text += str(item)
    elif isinstance(response, dict):
        chunks = response.get(
            "chunks",
            response.get("documents", response.get("results", response.get("parsed_doc"))),
        )
        if isinstance(chunks, list):
            for item in chunks:
                if isinstance(item, dict):
                    text += str(item.get("parsed_text", item.get("chunk_text", item.get("text", ""))))
        else:
            text = str(response.get("raw", response.get("text", "")))
    else:
        text = str(response)
    return text.strip()


def _extract_json_array_from_llm_response(response: Any) -> list[dict[str, Any]] | None:
    """Parse LLM response and extract a JSON array of objects."""
    text = _response_to_text(response)
    if not text:
        return None

    code_block = re.search(r"```(?:json)?\s*(\[[\s\S]*?\])\s*```", text)
    if code_block:
        try:
            parsed = json.loads(code_block.group(1))
            if isinstance(parsed, list):
                return [p for p in parsed if isinstance(p, dict)]
        except json.JSONDecodeError:
            pass

    array_match = re.search(r"\[[\s\S]*\]", text)
    if array_match:
        try:
            parsed = json.loads(array_match.group(0))
            if isinstance(parsed, list):
                return [p for p in parsed if isinstance(p, dict)]
        except json.JSONDecodeError:
            pass

    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return [p for p in parsed if isinstance(p, dict)]
    except json.JSONDecodeError:
        return None
    return None


def _clean_requirement_text(value: str, max_len: int = 1000) -> str:
    """Normalize requirement strings and bound prompt growth."""
    cleaned = " ".join(str(value or "").split())
    return cleaned[:max_len]


def _normalize_category_name(raw: str, configured: list[str]) -> str:
    """Normalize category names to configured buckets where possible."""
    value = " ".join(str(raw or "").strip().lower().replace("_", " ").split())
    if not value:
        return "other"
    configured_norm = {
        " ".join(c.lower().replace("_", " ").split()): c
        for c in configured
    }
    if value in configured_norm:
        return configured_norm[value]
    for cand_norm, original in configured_norm.items():
        if value in cand_norm or cand_norm in value:
            return original
    return value


def _infer_chunk_category(chunk: dict[str, Any], configured: list[str]) -> str:
    """Infer category from explicit field, then header/text keyword overlap."""
    explicit = chunk.get("category")
    if explicit:
        return _normalize_category_name(str(explicit), configured)
    probe = " ".join(
        [
            str(chunk.get("chunk_header_text", "")),
            str(chunk.get("chunk_text", ""))[:220],
        ]
    ).lower()
    best = ("other", 0)
    for c in configured:
        score = 0
        c_norm = c.lower().replace("_", " ")
        for token in c_norm.split():
            if len(token) >= 3 and token in probe:
                score += 1
        if score > best[1]:
            best = (c, score)
    return best[0] if best[1] > 0 else "other"


def _build_category_requirements(
    statute_chunks: list[dict[str, Any]],
    configured_categories: list[str],
) -> dict[tuple[str, str], dict[str, Any]]:
    """Group chunks into jurisdiction/category requirement buckets."""
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for chunk in statute_chunks:
        jurisdiction = str(chunk.get("jurisdiction", "")).strip()
        if not jurisdiction:
            continue
        category = _infer_chunk_category(chunk, configured_categories)
        key = (jurisdiction, category)
        if key not in grouped:
            grouped[key] = {
                "requirements": [],
                "statute_ids": set(),
                "raw_chunks": [],
            }
        requirement = _clean_requirement_text(
            str(chunk.get("chunk_text") or chunk.get("chunk_header_text") or ""),
            max_len=900,
        )
        if requirement:
            grouped[key]["requirements"].append(requirement)
        statute_id = str(chunk.get("document_id") or chunk.get("_id") or "").strip()
        if statute_id:
            grouped[key]["statute_ids"].add(statute_id)
        grouped[key]["raw_chunks"].append(chunk)

    # de-duplicate requirement text while preserving order and keeping prompt size bounded
    for data in grouped.values():
        seen: set[str] = set()
        deduped: list[str] = []
        for req in data["requirements"]:
            if req and req not in seen:
                deduped.append(req)
                seen.add(req)
            if len(deduped) >= 6:
                break
        data["requirements"] = deduped
    return grouped


def _category_pair_extraction_prompt(
    category_name: str,
    state_a: str,
    state_b: str,
    statute_a_id: str,
    statute_b_id: str,
    statute_a_requirements: list[str],
    statute_b_requirements: list[str],
) -> str:
    """Render category-pair extraction prompt."""
    req_a = "\n".join(f"- {r}" for r in statute_a_requirements) or "- (none provided)"
    req_b = "\n".join(f"- {r}" for r in statute_b_requirements) or "- (none provided)"
    return f"""SYSTEM:
You are a privacy compliance conflict analyst. You will be given
statutory requirements from two different jurisdictions for the
same compliance category. Identify direct conflicts - cases where
full compliance with one jurisdiction's requirement makes it
impossible or risky to fully comply with the other.

Do NOT flag differences that are merely stricter/looser versions
of the same obligation. A conflict exists ONLY when satisfying
Jurisdiction A creates a violation risk under Jurisdiction B.

CONTEXT:
Category: {category_name}

--- Jurisdiction A: {state_a} ---
Statute: {statute_a_id}
Requirements:
{req_a}

--- Jurisdiction B: {state_b} ---
Statute: {statute_b_id}
Requirements:
{req_b}

TASK:
Analyze these two sets of requirements and return a JSON array of
conflicts found. If no genuine conflicts exist, return an empty array.

For each conflict found, return:
{{
  "conflict_id": "<category>_<state_a>_<state_b>_<seq>",
  "category": "{category_name}",
  "jurisdiction_a": "{state_a}",
  "jurisdiction_b": "{state_b}",
  "requirement_a": "<specific requirement text or summary>",
  "requirement_b": "<specific requirement text or summary>",
  "conflict_type": "<one of: RETENTION_VS_DELETION | CONSENT_MODEL | NOTICE_TIMING | OPT_OUT_SCOPE | DATA_SCOPE_DEFINITION | ENFORCEMENT_MECHANISM | AGE_THRESHOLD | EXEMPTION_BOUNDARY | OTHER>",
  "description": "<2-3 sentences explaining why these cannot both be satisfied>",
  "severity": "<HIGH | MEDIUM | LOW>",
  "resolution_strategy": "<brief practical guidance on how to handle>"
}}

SEVERITY DEFINITIONS:
- HIGH: Compliance with A directly causes a violation of B. No middle ground exists without a legal interpretation or waiver.
- MEDIUM: Tension exists where a single policy/process cannot cleanly satisfy both. Workarounds are possible but non-trivial.
- LOW: Edge case conflict that only surfaces under specific conditions or narrow data types.

Return ONLY the JSON array. No preamble."""


def _conflict_validation_prompt(
    conflict_json: dict[str, Any],
    state_a: str,
    state_b: str,
    relevant_statute_a_text: str,
    relevant_statute_b_text: str,
) -> str:
    """Render conflict validation prompt."""
    return f"""SYSTEM:
You are a senior privacy law reviewer. You will be given a
detected conflict between two state privacy statutes. Your job
is to determine whether this is a TRUE conflict or a FALSE
POSITIVE.

A false positive occurs when:
- One requirement is simply stricter (not contradictory)
- A reasonable unified policy could satisfy both
- The conflict assumes an interpretation not supported by
  the statute text

CONFLICT:
{json.dumps(conflict_json, ensure_ascii=True)}

ORIGINAL STATUTE EXCERPTS:
Jurisdiction A ({state_a}):
{relevant_statute_a_text}

Jurisdiction B ({state_b}):
{relevant_statute_b_text}

Return JSON:
{{
  "conflict_id": "{str(conflict_json.get("conflict_id", ""))}",
  "verdict": "<CONFIRMED | FALSE_POSITIVE | DOWNGRADE>",
  "reasoning": "<2-3 sentences>",
  "revised_severity": "<HIGH | MEDIUM | LOW | null>",
  "revised_resolution_strategy": "<updated guidance or null>"
}}"""


def _normalize_conflict(
    conflict: dict[str, Any],
    category: str,
    state_a: str,
    state_b: str,
    seq: int,
) -> dict[str, Any]:
    """Normalize conflict payload to expected schema."""
    conflict_id = str(conflict.get("conflict_id") or f"{category}_{state_a}_{state_b}_{seq}")
    conflict_type = str(conflict.get("conflict_type") or "OTHER").upper()
    severity = str(conflict.get("severity") or "LOW").upper()
    if conflict_type not in CONFLICT_TYPES:
        conflict_type = "OTHER"
    if severity not in SEVERITY_LEVELS:
        severity = "LOW"
    return {
        "conflict_id": conflict_id,
        "category": str(conflict.get("category") or category),
        "jurisdiction_a": str(conflict.get("jurisdiction_a") or state_a),
        "jurisdiction_b": str(conflict.get("jurisdiction_b") or state_b),
        "requirement_a": _clean_requirement_text(str(conflict.get("requirement_a") or "")),
        "requirement_b": _clean_requirement_text(str(conflict.get("requirement_b") or "")),
        "conflict_type": conflict_type,
        "description": _clean_requirement_text(str(conflict.get("description") or ""), max_len=1400),
        "severity": severity,
        "resolution_strategy": _clean_requirement_text(str(conflict.get("resolution_strategy") or ""), max_len=900),
    }


def _normalize_validation_result(
    conflict_id: str,
    validation: dict[str, Any] | None,
) -> dict[str, Any]:
    """Normalize validator output shape."""
    if not isinstance(validation, dict):
        return {
            "conflict_id": conflict_id,
            "verdict": "CONFIRMED",
            "reasoning": "Validator response could not be parsed; treated as confirmed for manual review.",
            "revised_severity": None,
            "revised_resolution_strategy": None,
        }
    verdict = str(validation.get("verdict") or "CONFIRMED").upper()
    if verdict not in VALIDATION_VERDICTS:
        verdict = "CONFIRMED"
    revised_severity_raw = validation.get("revised_severity")
    revised_severity = None
    if revised_severity_raw is not None:
        candidate = str(revised_severity_raw).upper()
        if candidate in SEVERITY_LEVELS:
            revised_severity = candidate
    revised_resolution = validation.get("revised_resolution_strategy")
    return {
        "conflict_id": str(validation.get("conflict_id") or conflict_id),
        "verdict": verdict,
        "reasoning": _clean_requirement_text(str(validation.get("reasoning") or ""), max_len=1200),
        "revised_severity": revised_severity,
        "revised_resolution_strategy": (
            _clean_requirement_text(str(revised_resolution), max_len=900)
            if revised_resolution is not None
            else None
        ),
    }


def get_policy_text(
    forward_get: Callable[..., tuple[Any, Any]],
    database_name: str,
    policy_collection: str,
    policy_chunk_collection: str,
    policy_document_id: str | None = None,
    company_name: str | None = None,
) -> tuple[str, str, str]:
    """Return (full_policy_text, company_name, document_id). Uses policy doc or policy chunks."""
    if policy_document_id:
        docs = _get_documents(
            forward_get,
            database_name,
            policy_collection,
            {"document_id": policy_document_id},
        )
        if docs:
            d = docs[0]
            text = str(d.get("text", "")).strip()
            if not text:
                chunks = _get_documents(
                    forward_get,
                    database_name,
                    policy_chunk_collection,
                    {"document_id": _extract_document_id(d) or policy_document_id},
                )
                text = " ".join(
                    str(c.get("chunk_text", c.get("chunk_header_text", ""))) for c in chunks
                ).strip()
            return text, str(d.get("company_name", "") or ""), _extract_document_id(d) or policy_document_id
    if company_name:
        docs = _get_documents(
            forward_get,
            database_name,
            policy_collection,
            {"company_name": company_name},
        )
        if docs:
            d = docs[0]
            text = str(d.get("text", "")).strip()
            doc_id = _extract_document_id(d)
            if not text and doc_id:
                chunks = _get_documents(
                    forward_get,
                    database_name,
                    policy_chunk_collection,
                    {"document_id": doc_id},
                )
                text = " ".join(
                    str(c.get("chunk_text", c.get("chunk_header_text", ""))) for c in chunks
                ).strip()
            return text, str(d.get("company_name", "") or company_name), doc_id
    return "", "", policy_document_id or ""


def get_statute_chunks(
    forward_get: Callable[..., tuple[Any, Any]],
    forward_post: Callable[..., tuple[Any, Any]],
    database_name: str,
    statute_collection: str,
    statute_chunk_collection: str,
    jurisdictions: list[str],
    index_database_name: str | None = None,
    index_collection_name: str | None = None,
    query_categories: list[str] | None = None,
    top_k: int = 20,
    use_vector_search: bool = True,
) -> list[dict[str, Any]]:
    """Return list of statute chunks for the given jurisdictions. Uses vector-search when available, else fallback to list by jurisdiction."""
    query_categories = query_categories or ["right to know", "right to delete", "sale of data", "sensitive data"]
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    if use_vector_search and index_database_name and index_collection_name:
        for j in jurisdictions:
            for q in query_categories:
                data, error = forward_post(
                    "/vector-search",
                    {
                        "index_database_name": index_database_name,
                        "index_collection_name": index_collection_name,
                        "query_text": q,
                        "filter": {"jurisdiction": j},
                        "top_k": top_k,
                    },
                )
                if not error and isinstance(data, dict):
                    chunks = data.get("chunks", data.get("documents", data.get("results", [])))
                    if isinstance(chunks, list):
                        for c in chunks:
                            if isinstance(c, dict):
                                ref = (c.get("document_id", c.get("_id", "")), c.get("chunk_text", "")[:200])
                                if ref not in seen:
                                    seen.add(ref)
                                    c.setdefault("jurisdiction", j)
                                    out.append(c)

    if not out:
        # Fallback: get statute docs by jurisdiction, then their chunks
        for j in jurisdictions:
            statutes = _get_documents(
                forward_get,
                database_name,
                statute_collection,
                {"jurisdiction": j},
            )
            for s in statutes:
                doc_id = _extract_document_id(s)
                if not doc_id:
                    continue
                chunks = _get_documents(
                    forward_get,
                    database_name,
                    statute_chunk_collection,
                    {"document_id": doc_id},
                )
                for c in chunks:
                    ref = (doc_id, (c.get("chunk_text", "") or "")[:200])
                    if ref not in seen:
                        seen.add(ref)
                        c = dict(c)
                        c["jurisdiction"] = j
                        c["document_id"] = doc_id
                        out.append(c)
    return out


def run_applicability(
    forward_post: Callable[..., tuple[Any, Any]],
    forward_get: Callable[..., tuple[Any, Any]],
    database_name: str,
    policy_collection: str,
    policy_chunk_collection: str,
    policy_document_id: str,
) -> dict[str, Any]:
    """Determine applicable jurisdictions for a policy via SLM. Returns spec JSON."""
    text, company_name, _ = get_policy_text(
        forward_get,
        database_name,
        policy_collection,
        policy_chunk_collection,
        policy_document_id=policy_document_id,
    )
    if not text:
        return {
            "policy_document_id": policy_document_id,
            "applicable_jurisdictions": [],
            "confidence": {},
            "error": "policy_not_found",
        }

    prompt = (
        "List US state codes (e.g. CA, VA, CO, CT) and 'US' for US federal "
        "for which this privacy policy is likely intended, based on explicit or implicit references. "
        "Respond with only a JSON object: {\"applicable_jurisdictions\": [\"CA\", \"VA\", ...], "
        "\"confidence\": {\"CA\": 0.95, \"VA\": 0.8}}."
    )
    response, error = _parse_llm(
        forward_post,
        database_name,
        policy_collection,
        policy_document_id,
        prompt,
    )
    if error:
        return {
            "policy_document_id": policy_document_id,
            "applicable_jurisdictions": [],
            "confidence": {},
            "error": str(error[0]),
        }

    parsed = _extract_json_from_llm_response(response)
    if not parsed or "applicable_jurisdictions" not in parsed:
        return {
            "policy_document_id": policy_document_id,
            "applicable_jurisdictions": [],
            "confidence": parsed.get("confidence", {}) if isinstance(parsed, dict) else {},
            "error": "could_not_parse_slm_response",
        }
    return {
        "policy_document_id": policy_document_id,
        "company_name": company_name,
        "applicable_jurisdictions": parsed.get("applicable_jurisdictions", []),
        "confidence": parsed.get("confidence", {}),
    }


def run_gap_analysis(
    forward_post: Callable[..., tuple[Any, Any]],
    forward_get: Callable[..., tuple[Any, Any]],
    database_name: str,
    policy_collection: str,
    policy_chunk_collection: str,
    statute_collection: str,
    statute_chunk_collection: str,
    policy_document_id: str,
    applicable_jurisdictions: list[str] | None = None,
    config: dict[str, Any] | None = None,
    index_database_name: str | None = None,
    index_collection_name: str | None = None,
    save_results: bool = True,
    num_rows: int | None = None,
) -> dict[str, Any]:
    """Proxy to upstream /api/v4/compliance/gap-analysis. Returns spec JSON with gaps and summary."""
    config = config or load_config()
    jurisdictions = applicable_jurisdictions or config.get("default_jurisdictions", ["CA", "VA"])

    body: dict[str, Any] = {
        "policy_document_id": policy_document_id,
        "applicable_jurisdictions": jurisdictions,
        "database": database_name,
        "policy_collection": policy_collection,
        "save_results": save_results,
    }
    if num_rows is not None:
        body["num_rows"] = num_rows
    data, error = forward_post("/api/v4/compliance/gap-analysis", body)
    if error:
        msg, status = error
        return {
            "policy_document_id": policy_document_id,
            "company_name": "",
            "applicable_jurisdictions": jurisdictions,
            "analyzed_at": datetime.now(timezone.utc).isoformat(),
            "gaps": [],
            "summary": {"total_requirements": 0, "missing": 0, "addressed": 0, "partial": 0, "ambiguous": 0, "conflicts": 0},
            "error": msg,
        }
    return data


def run_multi_jurisdictional(
    forward_post: Callable[..., tuple[Any, Any]],
    forward_get: Callable[..., tuple[Any, Any]],
    database_name: str,
    statute_collection: str,
    statute_chunk_collection: str,
    applicable_jurisdictions: list[str],
    policy_document_id: str | None = None,
    policy_collection: str | None = None,
    policy_chunk_collection: str | None = None,
    config: dict[str, Any] | None = None,
    index_database_name: str | None = None,
    index_collection_name: str | None = None,
) -> dict[str, Any]:
    """Run strictest-common-denominator and conflict detection. Returns spec JSON."""
    config = config or load_config()
    canonical_ids = config.get("canonical_requirement_ids", [])
    statute_chunks = get_statute_chunks(
        forward_get,
        forward_post,
        database_name,
        statute_collection,
        statute_chunk_collection,
        applicable_jurisdictions,
        index_database_name=index_database_name,
        index_collection_name=index_collection_name,
        query_categories=config.get("disclosure_query_categories"),
        use_vector_search=config.get("use_vector_search", False),
    )

    # Build one requirement per canonical id; use first jurisdiction's description as label
    strictest: list[dict[str, Any]] = []
    for cid in canonical_ids:
        strictest.append({
            "canonical_requirement_id": cid,
            "label": cid.replace("_", " ").title(),
            "strictest_jurisdiction": applicable_jurisdictions[0] if applicable_jurisdictions else "",
            "strictest_description": "",
            "all_jurisdictions": list(applicable_jurisdictions),
            "policy_alignment": "not_provided",
            "policy_note": None,
        })

    category_config = config.get(
        "disclosure_query_categories",
        ["right to know", "right to delete", "sale of data", "sensitive data"],
    )
    if not isinstance(category_config, list):
        category_config = ["other"]

    grouped = _build_category_requirements(statute_chunks, [str(c) for c in category_config] + ["other"])
    by_jurisdiction: dict[str, set[str]] = {}
    for (jurisdiction, category) in grouped:
        by_jurisdiction.setdefault(jurisdiction, set()).add(category)

    conflicts: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for state_a, state_b in combinations(applicable_jurisdictions, 2):
        categories_a = by_jurisdiction.get(state_a, set())
        categories_b = by_jurisdiction.get(state_b, set())
        for category in sorted(categories_a & categories_b):
            a_data = grouped.get((state_a, category), {})
            b_data = grouped.get((state_b, category), {})
            req_a = list(a_data.get("requirements", []))
            req_b = list(b_data.get("requirements", []))
            if not req_a or not req_b:
                continue
            statute_a_id = sorted(a_data.get("statute_ids", set()))[0] if a_data.get("statute_ids") else ""
            statute_b_id = sorted(b_data.get("statute_ids", set()))[0] if b_data.get("statute_ids") else ""
            llm_document_id = statute_a_id or statute_b_id
            if not llm_document_id:
                continue
            prompt = _category_pair_extraction_prompt(
                category_name=category,
                state_a=state_a,
                state_b=state_b,
                statute_a_id=statute_a_id,
                statute_b_id=statute_b_id,
                statute_a_requirements=req_a,
                statute_b_requirements=req_b,
            )
            response, error = _parse_llm(
                forward_post,
                database_name,
                statute_collection,
                llm_document_id,
                prompt,
            )
            if error:
                continue
            detected_conflicts = _extract_json_array_from_llm_response(response) or []
            for idx, raw_conflict in enumerate(detected_conflicts, start=1):
                normalized = _normalize_conflict(raw_conflict, category, state_a, state_b, idx)
                validation_prompt = _conflict_validation_prompt(
                    conflict_json=normalized,
                    state_a=state_a,
                    state_b=state_b,
                    relevant_statute_a_text="\n".join(f"- {r}" for r in req_a),
                    relevant_statute_b_text="\n".join(f"- {r}" for r in req_b),
                )
                validation_response, validation_error = _parse_llm(
                    forward_post,
                    database_name,
                    statute_collection,
                    llm_document_id,
                    validation_prompt,
                )
                validation_parsed = None if validation_error else _extract_json_from_llm_response(validation_response)
                validation = _normalize_validation_result(normalized["conflict_id"], validation_parsed)
                if validation["verdict"] == "FALSE_POSITIVE":
                    continue
                if validation["verdict"] == "DOWNGRADE" and validation.get("revised_severity"):
                    normalized["severity"] = validation["revised_severity"]
                if validation.get("revised_resolution_strategy"):
                    normalized["resolution_strategy"] = validation["revised_resolution_strategy"]
                normalized["validation"] = validation
                normalized["statute_a_id"] = statute_a_id
                normalized["statute_b_id"] = statute_b_id
                if normalized["conflict_id"] in seen_ids:
                    normalized["conflict_id"] = f"{normalized['conflict_id']}_{uuid.uuid4().hex[:6]}"
                seen_ids.add(normalized["conflict_id"])
                conflicts.append(normalized)

    return {
        "applicable_jurisdictions": applicable_jurisdictions,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "strictest_common_denominator": strictest,
        "conflicts_between_jurisdictions": conflicts,
    }


def run_health_score(
    forward_post: Callable[..., tuple[Any, Any]],
    forward_get: Callable[..., tuple[Any, Any]],
    database_name: str,
    policy_collection: str,
    policy_chunk_collection: str,
    statute_collection: str,
    statute_chunk_collection: str,
    policy_document_id: str,
    applicable_jurisdictions: list[str] | None = None,
    gap_result: dict[str, Any] | None = None,
    config: dict[str, Any] | None = None,
    index_database_name: str | None = None,
    index_collection_name: str | None = None,
    weights: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Compute Privacy Health Score (0-100) from gap analysis. Returns spec JSON."""
    config = config or load_config()
    weights_config = dict(config.get("requirement_weights", {}))
    if weights:
        weights_config.update(weights)
    category_mapping = config.get("category_mapping", {})
    health = config.get("health_score", {})
    default_weight = float(health.get("default_weight", 1.0))
    conflict_mult = float(health.get("conflict_penalty_multiplier", 0.7))

    if gap_result is None:
        gap_result = run_gap_analysis(
            forward_post,
            forward_get,
            database_name,
            policy_collection,
            policy_chunk_collection,
            statute_collection,
            statute_chunk_collection,
            policy_document_id,
            applicable_jurisdictions=applicable_jurisdictions,
            config=config,
            index_database_name=index_database_name,
            index_collection_name=index_collection_name,
        )

    if gap_result.get("error") == "policy_not_found":
        return {
            "policy_document_id": policy_document_id,
            "company_name": "",
            "privacy_health_score": None,
            "score_breakdown": {},
            "components": {},
            "analyzed_at": datetime.now(timezone.utc).isoformat(),
            "error": "policy_not_found",
        }

    gaps = gap_result.get("gaps", [])
    if not gaps:
        return {
            "policy_document_id": gap_result.get("policy_document_id", policy_document_id),
            "company_name": gap_result.get("company_name", ""),
            "privacy_health_score": None,
            "score_breakdown": {},
            "components": {"requirements_total": 0, "addressed": 0, "missing": 0, "conflicts": 0},
            "analyzed_at": datetime.now(timezone.utc).isoformat(),
            "error": "no_applicable_statutes",
        }

    weighted_sum = 0.0
    max_possible = 0.0
    by_jurisdiction: dict[str, list[float]] = {}
    by_category: dict[str, list[float]] = {}
    for g in gaps:
        j = g.get("jurisdiction", "")
        req_summary = g.get("requirement_summary", "")
        w = float(weights_config.get(req_summary, default_weight))
        if j not in by_jurisdiction:
            by_jurisdiction[j] = []
        cat = "rights"
        for cid, c in category_mapping.items():
            if cid in req_summary or req_summary in cid:
                cat = c
                break
        if cat not in by_category:
            by_category[cat] = []
        max_possible += w
        status = g.get("status", "missing")
        if status == "addressed":
            score = 1.0
        elif status == "partial":
            score = 0.5
        elif status == "ambiguous":
            score = 0.25
        elif status == "conflict":
            score = 0.0
        else:
            score = 0.0
        weighted_sum += w * score
        by_jurisdiction[j].append(score)
        by_category[cat].append(score)

    raw_ratio = weighted_sum / max_possible if max_possible else 0.0
    conflicts = sum(1 for g in gaps if g.get("status") == "conflict")
    conflict_penalty_applied = conflicts > 0
    if conflict_penalty_applied:
        raw_ratio *= conflict_mult
    privacy_health_score = max(0, min(100, round(100 * raw_ratio)))

    score_breakdown = {
        "by_jurisdiction": {j: round(100 * (sum(v) / len(v)) if v else 0) for j, v in by_jurisdiction.items()},
        "by_category": {c: round(100 * (sum(v) / len(v)) if v else 0) for c, v in by_category.items()},
    }

    return {
        "policy_document_id": gap_result.get("policy_document_id", policy_document_id),
        "company_name": gap_result.get("company_name", ""),
        "privacy_health_score": privacy_health_score,
        "score_breakdown": score_breakdown,
        "components": {
            "requirements_total": len(gaps),
            "addressed": sum(1 for g in gaps if g.get("status") == "addressed"),
            "partial": sum(1 for g in gaps if g.get("status") == "partial"),
            "ambiguous": sum(1 for g in gaps if g.get("status") == "ambiguous"),
            "missing": sum(1 for g in gaps if g.get("status") == "missing"),
            "conflicts": conflicts,
            "raw_ratio": round(raw_ratio, 2),
            "conflict_penalty_applied": conflict_penalty_applied,
        },
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
    }


def run_drift_check(
    forward_post: Callable[..., tuple[Any, Any]],
    forward_get: Callable[..., tuple[Any, Any]],
    database_name: str,
    policy_collection: str,
    policy_chunk_collection: str,
    statute_collection: str,
    statute_chunk_collection: str,
    results_collection: str = "compliance_results",
    alerts_collection: str = "compliance_alerts",
    since: str | None = None,
    policy_document_ids: list[str] | None = None,
    config: dict[str, Any] | None = None,
    index_database_name: str | None = None,
    index_collection_name: str | None = None,
    write_alert: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Detect regulatory drift: re-run analysis and diff with last result; produce alerts."""
    config = config or load_config()
    now = datetime.now(timezone.utc).isoformat()

    # Get policies to re-analyze
    if policy_document_ids:
        policy_ids = list(policy_document_ids)
    else:
        policies = _get_documents(forward_get, database_name, policy_collection, None)
        policy_ids = [_extract_document_id(p) for p in policies if _extract_document_id(p)]

    alerts: list[dict[str, Any]] = []
    for pid in policy_ids:
        gap_result = run_gap_analysis(
            forward_post,
            forward_get,
            database_name,
            policy_collection,
            policy_chunk_collection,
            statute_collection,
            statute_chunk_collection,
            pid,
            config=config,
            index_database_name=index_database_name,
            index_collection_name=index_collection_name,
        )
        score_result = run_health_score(
            forward_post,
            forward_get,
            database_name,
            policy_collection,
            policy_chunk_collection,
            statute_collection,
            statute_chunk_collection,
            pid,
            gap_result=gap_result,
            config=config,
        )

        # Try to get previous result for diff
        prev = _get_documents(
            forward_get,
            database_name,
            results_collection,
            {"policy_document_id": pid},
        )
        prev_result = prev[0] if prev else None
        prev_score = None
        prev_gaps: list[dict[str, Any]] = []
        if prev_result:
            prev_score = prev_result.get("privacy_health_score")
            prev_gaps = prev_result.get("gaps", [])

        current_score = score_result.get("privacy_health_score")
        current_gaps = gap_result.get("gaps", [])
        new_gaps = [g for g in current_gaps if g.get("status") in ("missing", "conflict") and g not in prev_gaps]
        resolved_gaps = [g for g in prev_gaps if g not in current_gaps]
        score_delta = (current_score - prev_score) if prev_score is not None and current_score is not None else None

        if new_gaps or (score_delta is not None and score_delta < 0):
            alert = {
                "alert_id": str(uuid.uuid4()),
                "type": "regulatory_drift",
                "policy_document_id": pid,
                "company_name": gap_result.get("company_name", ""),
                "trigger": "new_statute_indexed",
                "affected_jurisdictions": list({g.get("jurisdiction") for g in new_gaps if g.get("jurisdiction")}),
                "new_gaps": new_gaps,
                "resolved_gaps": resolved_gaps,
                "score_delta": score_delta,
                "previous_score": prev_score,
                "current_score": current_score,
                "detected_at": now,
            }
            alerts.append(alert)
            if write_alert:
                write_alert(alert)

    return {
        "analyzed_at": now,
        "policies_checked": len(policy_ids),
        "alerts": alerts,
    }
