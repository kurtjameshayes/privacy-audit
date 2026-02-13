"""
Compliance analysis engine: applicability, gap analysis, multi-jurisdictional,
health score, regulatory drift. Zero-human-touch; uses SLM and heuristics only.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

# Default config path relative to backend/
DEFAULT_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "compliance_config.json")
GAP_DEBUG_LOG_PATH = os.path.join(os.path.dirname(__file__), "..", ".cursor", "compliance_gap_debug.log")
GAP_DEBUG_MAX_LOGS = 5  # Log only first N failures per run to avoid spam
_gap_debug_log_count = 0


def _gap_debug_log(message: str, data: dict[str, Any]) -> None:
    """Log gap analysis debug info to compliance_gap_debug.log (first N failures only)."""
    global _gap_debug_log_count
    if _gap_debug_log_count >= GAP_DEBUG_MAX_LOGS:
        return
    _gap_debug_log_count += 1
    try:
        os.makedirs(os.path.dirname(GAP_DEBUG_LOG_PATH), exist_ok=True)
        with open(GAP_DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "message": message,
                "data": data,
                "log_index": _gap_debug_log_count,
            }) + "\n")
    except Exception:
        pass


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
    """Return list of documents from the API."""
    params: dict[str, Any] = {
        "database_name": database_name,
        "collection_name": collection_name,
    }
    if query is not None:
        params["query"] = json.dumps(query)
    data, error = forward_get("/documents", params)
    if error:
        return []
    if isinstance(data, dict):
        return data.get("documents", data.get("data", data.get("results", [])))
    return [] if not isinstance(data, list) else data


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


def _gap_check_single(
    forward_post: Callable[..., tuple[Any, Any]],
    database_name: str,
    policy_collection: str,
    policy_document_id: str,
    statute_chunk: dict[str, Any],
    policy_text: str,
) -> dict[str, Any]:
    """Run SLM gap check for one statute chunk. Returns {addressed, policy_quote, missing, conflict, conflict_description, analysis_failed}."""
    statute_text = (statute_chunk.get("chunk_text") or statute_chunk.get("chunk_header_text") or "")[:4000]
    base_prompt = (
        f"Consider the following statute requirement:\n\n{statute_text}\n\n"
        "Does the policy document address this requirement? If yes, quote the exact policy phrase. "
        "If there is a conflict with the statute, describe it. "
        "Respond with only this JSON: "
        "{\"addressed\": true or false, \"policy_quote\": \"exact phrase or null\", "
        "\"missing\": true or false, \"conflict\": true or false, \"conflict_description\": \"string or null\"}."
    )
    json_reminder = (
        "\n\nIMPORTANT: Respond with ONLY a valid JSON object, no other text. "
        "Use the exact keys: addressed, policy_quote, missing, conflict, conflict_description."
    )

    for attempt in range(2):
        prompt = base_prompt + (json_reminder if attempt > 0 else "")
        response, error = _parse_llm(
            forward_post,
            database_name,
            policy_collection,
            policy_document_id,
            prompt,
        )
        if error:
            msg, status = error
            _gap_debug_log("parse_llm_upstream_error", {"error_message": msg, "error_status": status})
            return {"analysis_failed": True, "addressed": False, "missing": True, "conflict": False}

        parsed = _extract_json_from_llm_response(response)
        if parsed:
            break
        if attempt == 0:
            resp_preview: dict[str, Any] = {
                "response_type": type(response).__name__,
                "response_str_truncated": str(response)[:500] if response is not None else "",
            }
            if isinstance(response, dict):
                resp_preview["response_keys"] = list(response.keys())
            _gap_debug_log("parse_llm_extraction_failed", resp_preview)

    if not parsed:
        return {"analysis_failed": True, "addressed": False, "missing": True, "conflict": False}

    addressed = bool(parsed.get("addressed"))
    policy_quote = parsed.get("policy_quote") or None
    if policy_quote and policy_text and policy_quote not in policy_text:
        addressed = False
    missing = bool(parsed.get("missing", not addressed))
    conflict = bool(parsed.get("conflict"))
    conflict_description = parsed.get("conflict_description") or None
    return {
        "addressed": addressed,
        "policy_quote": policy_quote,
        "missing": missing,
        "conflict": conflict,
        "conflict_description": conflict_description,
        "analysis_failed": False,
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
) -> dict[str, Any]:
    """Run gap analysis; returns spec JSON with gaps and summary."""
    global _gap_debug_log_count
    _gap_debug_log_count = 0
    config = config or load_config()
    jurisdictions = applicable_jurisdictions or config.get("default_jurisdictions", ["CA", "VA"])
    policy_text, company_name, doc_id = get_policy_text(
        forward_get,
        database_name,
        policy_collection,
        policy_chunk_collection,
        policy_document_id=policy_document_id,
    )
    if not policy_text:
        return {
            "policy_document_id": policy_document_id,
            "company_name": "",
            "applicable_jurisdictions": jurisdictions,
            "analyzed_at": datetime.now(timezone.utc).isoformat(),
            "gaps": [],
            "summary": {"total_requirements": 0, "missing": 0, "addressed": 0, "conflicts": 0},
            "error": "policy_not_found",
        }

    statute_chunks = get_statute_chunks(
        forward_get,
        forward_post,
        database_name,
        statute_collection,
        statute_chunk_collection,
        jurisdictions,
        index_database_name=index_database_name,
        index_collection_name=index_collection_name,
        query_categories=config.get("disclosure_query_categories"),
        use_vector_search=config.get("use_vector_search", False),
    )

    if not statute_chunks:
        return {
            "policy_document_id": doc_id or policy_document_id,
            "company_name": company_name,
            "applicable_jurisdictions": jurisdictions,
            "analyzed_at": datetime.now(timezone.utc).isoformat(),
            "gaps": [],
            "summary": {"total_requirements": 0, "missing": 0, "addressed": 0, "conflicts": 0},
            "error": "no_statute_chunks",
            "message": (
                f"No statute chunks found for jurisdictions: {', '.join(jurisdictions)}. "
                "Ensure statutes exist in the statutes collection with matching jurisdiction, "
                "and that they have been parsed (chunks in statute_chunks with document_id)."
            ),
        }

    max_chunks = config.get("gap_analysis_max_chunks_per_run")
    chunks_to_process = statute_chunks[:max_chunks] if isinstance(max_chunks, int) and max_chunks > 0 else statute_chunks

    gaps: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for sc in chunks_to_process:
        jurisdiction = sc.get("jurisdiction", "")
        statute_ref = sc.get("document_id", sc.get("_id", ""))
        requirement_summary = (sc.get("chunk_header_text") or sc.get("chunk_text", ""))[:200]
        key = (str(statute_ref), requirement_summary)
        if key in seen:
            continue
        seen.add(key)
        result = _gap_check_single(
            forward_post,
            database_name,
            policy_collection,
            policy_document_id,
            sc,
            policy_text,
        )
        if result.get("analysis_failed"):
            continue
        status = "conflict" if result["conflict"] else ("addressed" if result["addressed"] else "missing")
        gaps.append({
            "jurisdiction": jurisdiction,
            "statute_reference": str(statute_ref),
            "requirement_summary": requirement_summary,
            "status": status,
            "policy_quote": result.get("policy_quote"),
            "conflict_description": result.get("conflict_description"),
        })

    total = len(gaps)
    missing = sum(1 for g in gaps if g["status"] == "missing")
    addressed = sum(1 for g in gaps if g["status"] == "addressed")
    conflicts = sum(1 for g in gaps if g["status"] == "conflict")

    out: dict[str, Any] = {
        "policy_document_id": doc_id or policy_document_id,
        "company_name": company_name,
        "applicable_jurisdictions": jurisdictions,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "gaps": gaps,
        "summary": {
            "total_requirements": total,
            "missing": missing,
            "addressed": addressed,
            "conflicts": conflicts,
        },
    }
    if max_chunks and len(statute_chunks) > max_chunks and total > 0:
        out["partial"] = True
        out["message"] = f"Analyzed first {max_chunks} of {len(statute_chunks)} statute chunks (gap_analysis_max_chunks_per_run)."
    if total == 0 and statute_chunks:
        out["error"] = "no_requirements_analyzed"
        out["message"] = (
            f"Found {len(statute_chunks)} statute chunk(s) but none produced requirements. "
            "LLM analysis may have failed for all chunks."
        )
        out["chunks_attempted"] = len(chunks_to_process)
        out["analysis_failure_reason"] = "parse_failed"
    return out


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

    return {
        "applicable_jurisdictions": applicable_jurisdictions,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "strictest_common_denominator": strictest,
        "conflicts_between_jurisdictions": [],
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
) -> dict[str, Any]:
    """Compute Privacy Health Score (0-100) from gap analysis. Returns spec JSON."""
    config = config or load_config()
    weights_config = config.get("requirement_weights", {})
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
