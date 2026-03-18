from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from flask import Blueprint, jsonify, request

from backend.config import (
    COMPLIANCE_ALERTS_COLLECTION,
    COMPLIANCE_JOBS_COLLECTION,
    COMPLIANCE_RESULTS_COLLECTION,
    COMPLIANCE_RUN_LOG_COLLECTION,
    CONFLICT_RESULTS_COLLECTION,
    POLICY_CHUNK_COLLECTION,
    POLICY_COLLECTION,
    POLICY_DATABASE,
    POLICY_LEGAL_EMBEDDINGS_COLLECTION,
    STATUTE_CHUNK_COLLECTION,
    STATUTE_COLLECTION,
)
from backend.upstream import forward_delete, forward_get, forward_post

try:
    from backend.compliance.engine import (
        load_config as load_compliance_config,
        run_applicability,
        run_drift_check,
        run_gap_analysis,
        run_health_score,
        run_multi_jurisdictional,
    )
    from backend.workflow import (
        assert_policy_ready_for_compliance,
        assert_statute_indexed_for_jurisdiction,
    )
except ImportError:
    from compliance.engine import (
        load_config as load_compliance_config,
        run_applicability,
        run_drift_check,
        run_gap_analysis,
        run_health_score,
        run_multi_jurisdictional,
    )
    from workflow import (
        assert_policy_ready_for_compliance,
        assert_statute_indexed_for_jurisdiction,
    )

logger = logging.getLogger(__name__)

bp = Blueprint("compliance", __name__)


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def _write_compliance_document(collection: str, document: dict[str, Any]) -> None:
    """Persist a document to the compliance results/alerts/run_log collection."""
    _, error = forward_post(
        "/write_to_collection",
        {
            "database_name": POLICY_DATABASE,
            "collection_name": collection,
            "document": document,
            "mode": "append",
        },
    )
    if error:
        msg, status = error
        logger.error("Failed to write to %s: %s (status=%s)", collection, msg, status)


def _workflow_collection() -> str:
    config = load_compliance_config()
    return config.get("workflow_state_collection", "document_workflow_state")


def _upsert_compliance_job(job_doc: dict[str, Any]) -> None:
    """Upsert a compliance job in COMPLIANCE_JOBS_COLLECTION by job_id."""
    job_id = str(job_doc.get("job_id", "")).strip()
    if not job_id:
        return
    forward_delete(
        "/documents",
        {
            "database_name": POLICY_DATABASE,
            "collection_name": COMPLIANCE_JOBS_COLLECTION,
            "query": json.dumps({"job_id": job_id}),
        },
    )
    _write_compliance_document(COMPLIANCE_JOBS_COLLECTION, job_doc)


def _persist_conflict_results(
    result: dict[str, Any],
    run_id: str,
    model_version: str,
) -> None:
    """Persist multi-jurisdictional conflicts to conflict_results."""
    created_at = datetime.now(timezone.utc).isoformat()
    for conflict in result.get("conflicts_between_jurisdictions", []) or []:
        if not isinstance(conflict, dict):
            continue
        conflict_doc = {
            "conflict_id": conflict.get("conflict_id"),
            "category": conflict.get("category"),
            "jurisdiction_a": conflict.get("jurisdiction_a"),
            "jurisdiction_b": conflict.get("jurisdiction_b"),
            "requirement_a": conflict.get("requirement_a"),
            "requirement_b": conflict.get("requirement_b"),
            "conflict_type": conflict.get("conflict_type"),
            "description": conflict.get("description"),
            "severity": conflict.get("severity"),
            "resolution_strategy": conflict.get("resolution_strategy"),
            "validation": conflict.get("validation", {}),
            "statute_a_id": conflict.get("statute_a_id"),
            "statute_b_id": conflict.get("statute_b_id"),
            "run_id": run_id,
            "created_at": created_at,
            "model_version": model_version,
        }
        _write_compliance_document(CONFLICT_RESULTS_COLLECTION, conflict_doc)


def _run_compliance_job_in_background(
    job_id: str,
    job_type: str,
    job_request: dict[str, Any],
) -> None:
    """Execute compliance job async and update job status/result."""
    logger.info("Background job started: job_id=%s type=%s", job_id, job_type)
    now = datetime.now(timezone.utc).isoformat()
    config = load_compliance_config()
    index_db = job_request.get("index_database_name") or config.get("index_database_name")
    index_coll = job_request.get("index_collection_name") or config.get("index_collection_name")
    result: dict[str, Any] | None = None
    try:
        policy_document_id = str(job_request.get("policy_document_id", "")).strip()
        jurisdictions = job_request.get("applicable_jurisdictions")
        if isinstance(jurisdictions, list):
            jurisdictions = [str(j) for j in jurisdictions if str(j).strip()]
        else:
            jurisdictions = None

        if job_type == "gap_analysis":
            num_rows = job_request.get("num_rows")
            if num_rows is not None:
                try:
                    num_rows = int(num_rows)
                except (TypeError, ValueError):
                    num_rows = None
            result = run_gap_analysis(
                forward_post,
                forward_get,
                POLICY_DATABASE,
                POLICY_COLLECTION,
                POLICY_CHUNK_COLLECTION,
                STATUTE_COLLECTION,
                STATUTE_CHUNK_COLLECTION,
                policy_document_id,
                applicable_jurisdictions=jurisdictions,
                config=config,
                index_database_name=index_db,
                index_collection_name=index_coll,
                save_results=True,
                num_rows=num_rows,
            )
        elif job_type == "health_score":
            result = run_health_score(
                forward_post,
                forward_get,
                POLICY_DATABASE,
                POLICY_COLLECTION,
                POLICY_CHUNK_COLLECTION,
                STATUTE_COLLECTION,
                STATUTE_CHUNK_COLLECTION,
                policy_document_id,
                applicable_jurisdictions=jurisdictions,
                gap_result=None,
                config=config,
                index_database_name=index_db,
                index_collection_name=index_coll,
                weights=None,
            )
            doc = {**result, "run_at": datetime.now(timezone.utc).isoformat()}
            doc["job_type"] = "health_score"
            doc["run_types"] = doc.get("run_types") or ["health_score"]
            if "error" in result:
                doc["compliance_error"] = result["error"]
            if "message" in result:
                doc["compliance_message"] = result["message"]
            _write_compliance_document(COMPLIANCE_RESULTS_COLLECTION, doc)
        elif job_type == "multi_jurisdictional":
            result = run_multi_jurisdictional(
                forward_post,
                forward_get,
                POLICY_DATABASE,
                STATUTE_COLLECTION,
                STATUTE_CHUNK_COLLECTION,
                jurisdictions or [],
                policy_document_id=policy_document_id or None,
                policy_collection=POLICY_COLLECTION,
                policy_chunk_collection=POLICY_CHUNK_COLLECTION,
                config=config,
                index_database_name=index_db,
                index_collection_name=index_coll,
            )
            model_version = str(job_request.get("model_version", "")).strip() or os.getenv("MODEL_VERSION", "unknown")
            _persist_conflict_results(result, run_id=job_id, model_version=model_version)
        elif job_type == "policy_statute":
            jurisdiction = str(job_request.get("jurisdiction", "")).strip()
            policy_collection = str(job_request.get("policy_collection", "")).strip() or POLICY_LEGAL_EMBEDDINGS_COLLECTION
            upstream_result, upstream_error = forward_post(
                "/api/compliance/policy-statute-compliance",
                {
                    "policy_id": policy_document_id,
                    "policy_collection": policy_collection,
                    "jurisdiction": jurisdiction,
                },
            )
            if upstream_error:
                msg, _ = upstream_error
                raise RuntimeError(str(msg))
            result = dict(upstream_result) if isinstance(upstream_result, dict) else {"raw": upstream_result}
        elif job_type == "risk_assessment":
            body = {
                "policy_document_id": policy_document_id,
                "applicable_jurisdictions": jurisdictions,
                "template_id": str(job_request.get("template_id", "default")).strip() or "default",
                "include_report": bool(job_request.get("include_report", False)),
            }
            upstream_result, upstream_error = forward_post("/api/compliance/risk-assessment", body, timeout=300)
            if upstream_error:
                msg, _ = upstream_error
                raise RuntimeError(str(msg))
            result = dict(upstream_result) if isinstance(upstream_result, dict) else {"raw": upstream_result}
            doc = {
                "result": result,
                "policy_document_id": policy_document_id,
                "company_name": result.get("company_name"),
                "job_type": "risk_assessment",
                "run_types": ["risk_assessment"],
                "run_at": datetime.now(timezone.utc).isoformat(),
                "job_id": job_id,
                "analyzed_at": result.get("analyzed_at"),
            }
            _write_compliance_document(COMPLIANCE_RESULTS_COLLECTION, doc)
        else:
            raise ValueError(f"unsupported_job_type:{job_type}")

        logger.info("Background job completed: job_id=%s type=%s", job_id, job_type)
        completed = datetime.now(timezone.utc).isoformat()
        _upsert_compliance_job(
            {
                "job_id": job_id,
                "job_type": job_type,
                "status": "completed",
                "created_at": now,
                "completed_at": completed,
                "request": job_request,
                "result": result,
            }
        )
    except Exception as exc:
        logger.exception("Compliance job %s failed", job_id)
        completed = datetime.now(timezone.utc).isoformat()
        _upsert_compliance_job(
            {
                "job_id": job_id,
                "job_type": job_type,
                "status": "failed",
                "created_at": now,
                "completed_at": completed,
                "request": job_request,
                "error": str(exc),
            }
        )


def _infer_job_type(doc: dict[str, Any], default: str) -> str:
    """Extract job_type from doc, inferring from structure when missing."""
    job_type = doc.get("job_type")
    if job_type:
        return job_type
    run_types = doc.get("run_types")
    if run_types and len(run_types) > 0:
        return run_types[0]
    if doc.get("privacy_health_score") is not None and (
        "score_breakdown" in doc or "components" in doc
    ):
        return "health_score"
    return default


def _run_detail_to_compliance_view(doc: dict[str, Any]) -> dict[str, Any]:
    """Transform run detail (job-shaped, health_score, drift_check, or flat gap format) into user-friendly compliance view."""
    res = doc.get("result")
    if isinstance(res, dict):
        has_gaps = isinstance(res.get("gaps"), list)
        has_health_score = res.get("privacy_health_score") is not None
        has_risk_assessment = res.get("assessment") is not None
        if has_gaps or has_health_score or has_risk_assessment:
            req = doc.get("request") or {}
            pid = req.get("policy_document_id") or res.get("policy_document_id")
            job_type = doc.get("job_type") or (
                "risk_assessment" if has_risk_assessment
                else "health_score" if has_health_score and not has_gaps
                else "gap_analysis"
            )
            return {
                "result": res,
                "request": req,
                "policy_document_id": pid,
                "run_id": _mongo_id_str(doc.get("_id")) or _mongo_id_str(doc.get("job_id")),
                "run_at": doc.get("completed_at") or doc.get("created_at") or res.get("analyzed_at"),
                "status": doc.get("status", "completed"),
                "job_type": job_type,
                "created_at": doc.get("created_at"),
                "completed_at": doc.get("completed_at"),
                "privacy_health_score": res.get("privacy_health_score"),
            }
    if doc.get("assessment") is not None and not isinstance(doc.get("result"), dict):
        job_type = "risk_assessment"
        result = {
            "assessment": doc.get("assessment"),
            "report": doc.get("report"),
            "policy_document_id": doc.get("policy_document_id"),
            "company_name": doc.get("company_name"),
            "analyzed_at": doc.get("analyzed_at", doc.get("run_at")),
        }
        return {
            "result": result,
            "request": {"policy_document_id": doc.get("policy_document_id")},
            "policy_document_id": doc.get("policy_document_id"),
            "run_id": _mongo_id_str(doc.get("_id")) or _mongo_id_str(doc.get("job_id")),
            "run_at": doc.get("analyzed_at") or doc.get("run_at"),
            "status": "completed",
            "job_type": job_type,
            "created_at": doc.get("created_at"),
            "completed_at": doc.get("completed_at"),
        }
    if doc.get("privacy_health_score") is not None and not isinstance(doc.get("gaps"), list):
        job_type = _infer_job_type(doc, "health_score")
        result = dict(doc)
        result.pop("_id", None)
        result.setdefault("policy_document_id", doc.get("policy_document_id"))
        result.setdefault("company_name", doc.get("company_name"))
        result.setdefault("privacy_health_score", doc.get("privacy_health_score"))
        result.setdefault("score_breakdown", doc.get("score_breakdown", {}))
        result.setdefault("components", doc.get("components", {}))
        result.setdefault("analyzed_at", doc.get("analyzed_at", doc.get("run_at")))
        return {
            "result": result,
            "request": {"policy_document_id": doc.get("policy_document_id")},
            "policy_document_id": doc.get("policy_document_id"),
            "run_id": _mongo_id_str(doc.get("_id")),
            "run_at": doc.get("analyzed_at") or doc.get("run_at"),
            "status": "completed",
            "job_type": job_type,
            "created_at": doc.get("created_at"),
            "completed_at": doc.get("completed_at"),
            "privacy_health_score": doc.get("privacy_health_score"),
        }
    if isinstance(doc.get("gaps"), list) and (
        doc.get("policy_document_id") or doc.get("company_name")
    ):
        pid = doc.get("policy_document_id")
        gaps = doc.get("gaps", [])
        summary = _normalize_gap_summary(gaps, doc.get("summary"))
        result = {**doc, "summary": summary}
        job_type = _infer_job_type(doc, "gap_analysis")
        return {
            "result": result,
            "request": {"policy_document_id": pid},
            "policy_document_id": pid,
            "run_id": _mongo_id_str(doc.get("_id")),
            "run_at": doc.get("analyzed_at", doc.get("run_at")),
            "status": "completed",
            "job_type": job_type,
        }
    alerts = doc.get("alerts", [])
    gaps: list[dict[str, Any]] = []
    policy_document_id = ""
    company_name: str | None = None
    jurisdictions: set[str] = set()
    for a in alerts:
        pid = a.get("policy_document_id", "")
        if pid and not policy_document_id:
            policy_document_id = pid
        cn = a.get("company_name")
        if cn is not None and company_name is None:
            company_name = str(cn) if cn else None
        for j in a.get("affected_jurisdictions", []):
            if j:
                jurisdictions.add(str(j))
        for g in a.get("new_gaps", []):
            g = dict(g) if isinstance(g, dict) else {}
            if "status" not in g:
                g["status"] = "missing"
            gaps.append(g)
        for g in a.get("resolved_gaps", []):
            g = dict(g) if isinstance(g, dict) else {}
            g["status"] = "addressed"
            gaps.append(g)
    summary = {
        "addressed": sum(len(a.get("resolved_gaps", [])) for a in alerts),
        "partial": 0,
        "ambiguous": 0,
        "missing": sum(len(a.get("new_gaps", [])) for a in alerts),
        "conflicts": 0,
        "total_requirements": sum(
            len(a.get("new_gaps", [])) + len(a.get("resolved_gaps", []))
            for a in alerts
        ),
    }
    health_score = None
    if alerts:
        health_score = next(
            (a.get("current_score") for a in alerts if a.get("current_score") is not None),
            None
        )
    result = {
        "gaps": gaps,
        "policy_document_id": policy_document_id or None,
        "company_name": company_name,
        "summary": summary,
        "analyzed_at": doc.get("analyzed_at", ""),
        "applicable_jurisdictions": sorted(jurisdictions),
    }
    job_type = _infer_job_type(doc, "regulatory_drift")
    return {
        "result": result,
        "request": {"policy_document_id": policy_document_id or None},
        "policy_document_id": policy_document_id or None,
        "run_id": _mongo_id_str(doc.get("_id")),
        "run_at": doc.get("analyzed_at", ""),
        "status": "completed",
        "job_type": job_type,
        "created_at": doc.get("analyzed_at", ""),
        "completed_at": doc.get("analyzed_at", ""),
        "privacy_health_score": health_score,
    }


def _normalize_gap_summary(gaps: list[dict[str, Any]], existing: dict[str, Any] | None) -> dict[str, Any]:
    """Ensure summary includes partial and ambiguous counts from gaps."""
    summary = dict(existing or {})
    if gaps:
        summary["total_requirements"] = len(gaps)
        summary["addressed"] = sum(1 for g in gaps if g.get("status") == "addressed")
        summary["partial"] = sum(1 for g in gaps if g.get("status") == "partial")
        summary["ambiguous"] = sum(1 for g in gaps if g.get("status") == "ambiguous")
        summary["missing"] = sum(1 for g in gaps if g.get("status") == "missing")
        summary["conflicts"] = sum(1 for g in gaps if g.get("status") == "conflict")
    summary.setdefault("partial", 0)
    summary.setdefault("ambiguous", 0)
    return summary


def _mongo_id_str(rid: Any) -> str:
    """Convert MongoDB _id to string (handles ObjectId/$oid)."""
    if rid is None:
        return ""
    if isinstance(rid, dict) and "$oid" in rid:
        return str(rid["$oid"])
    return str(rid)


def _fetch_documents(collection: str) -> list[dict[str, Any]]:
    """Fetch all documents from a collection via upstream /documents."""
    params: dict[str, Any] = {
        "database_name": POLICY_DATABASE,
        "collection_name": collection,
    }
    data, error = forward_get("/documents", params)
    if error:
        return []
    if isinstance(data, dict):
        docs = data.get("documents", data.get("data", data.get("results", [])))
        return docs if isinstance(docs, list) else []
    return []


def _run_timestamp(doc: dict[str, Any]) -> str:
    """Extract run timestamp from doc; upstream may use run_at, analyzed_at, created_at, completed_at, or started_at."""
    return (
        doc.get("run_at")
        or doc.get("analyzed_at")
        or doc.get("created_at")
        or doc.get("completed_at")
        or doc.get("started_at")
        or ""
    )


def _runs_from_compliance_run_log(
    limit: int, offset: int,
    policy_document_id: str = "",
    since: str = "",
    until: str = "",
    types: str = "",
) -> dict[str, Any]:
    """Fetch runs from compliance_jobs, compliance_run_log, and compliance_results."""
    all_runs: list[dict[str, Any]] = []

    jobs_docs = _fetch_documents(COMPLIANCE_JOBS_COLLECTION)
    for doc in jobs_docs:
        run_id = _mongo_id_str(doc.get("_id")) or _mongo_id_str(doc.get("job_id"))
        if not run_id:
            continue
        run_at = _run_timestamp(doc)
        req = doc.get("request") or {}
        res = doc.get("result") or {}
        pid = req.get("policy_document_id") or res.get("policy_document_id") or doc.get("policy_document_id") or ""
        company_name = res.get("company_name") or doc.get("company_name")
        summary = res.get("summary") or doc.get("summary") or {}
        components = res.get("components") or doc.get("components") or {}
        total = summary.get("total_requirements") or components.get("requirements_total", 0)
        job_type = doc.get("job_type")
        if not job_type:
            continue
        all_runs.append({
            "run_id": run_id,
            "job_id": run_id,
            "policy_document_id": str(pid) if pid else "",
            "company_name": company_name,
            "run_at": run_at,
            "created_at": doc.get("created_at") or run_at,
            "completed_at": doc.get("completed_at") or run_at,
            "privacy_health_score": res.get("privacy_health_score") or doc.get("privacy_health_score"),
            "status": doc.get("status") or "completed",
            "job_type": job_type,
            "summary": {
                "addressed": summary.get("addressed", 0),
                "partial": summary.get("partial", 0),
                "ambiguous": summary.get("ambiguous", 0),
                "missing": summary.get("missing", 0),
                "conflicts": summary.get("conflicts", 0),
                "total_requirements": total,
            },
            "types": [job_type],
            "_source": "compliance_jobs",
            "_doc": doc,
        })

    run_log_docs = _fetch_documents(COMPLIANCE_RUN_LOG_COLLECTION)
    for doc in run_log_docs:
        run_id = _mongo_id_str(doc.get("_id"))
        analyzed_at = _run_timestamp(doc)
        alerts = doc.get("alerts", [])
        pid = doc.get("policy_document_id", "")
        company_name = doc.get("company_name")
        first: dict[str, Any] = {}
        if alerts:
            first = next((a for a in alerts if a.get("policy_document_id")), alerts[0])
            pid = pid or first.get("policy_document_id", "")
            company_name = company_name or first.get("company_name")
        doc_types = doc.get("run_types") or doc.get("types") or []
        job_type = doc.get("job_type") or (doc_types[0] if doc_types else "regulatory_drift")
        type_list = list(doc_types) if doc_types else [job_type]
        all_runs.append({
            "run_id": run_id,
            "job_id": run_id,
            "policy_document_id": pid or "",
            "company_name": company_name,
            "run_at": analyzed_at,
            "created_at": analyzed_at,
            "completed_at": analyzed_at,
            "privacy_health_score": first.get("current_score") if first else None,
            "status": "completed",
            "job_type": job_type,
            "summary": {
                "addressed": sum(len(a.get("resolved_gaps", [])) for a in alerts),
                "missing": sum(len(a.get("new_gaps", [])) for a in alerts),
                "conflicts": 0,
                "total_requirements": sum(
                    len(a.get("new_gaps", [])) + len(a.get("resolved_gaps", []))
                    for a in alerts
                ),
            },
            "types": type_list,
            "_source": "compliance_run_log",
            "_doc": doc,
        })

    jobs_job_ids = {r.get("job_id") or r.get("run_id") for r in all_runs if r.get("job_id") or r.get("run_id")}
    results_docs = _fetch_documents(COMPLIANCE_RESULTS_COLLECTION)
    for doc in results_docs:
        doc_job_id = str(doc.get("job_id", "")).strip()
        if doc_job_id and doc_job_id in jobs_job_ids:
            continue
        run_id = doc_job_id or _mongo_id_str(doc.get("_id"))
        if not run_id:
            continue
        run_at = _run_timestamp(doc)
        summary = doc.get("summary", {})
        components = doc.get("components", {})
        total = summary.get("total_requirements") or components.get("requirements_total", 0)
        doc_types = doc.get("run_types") or doc.get("types") or []
        job_type = doc.get("job_type") or (doc_types[0] if doc_types else "gap_analysis")
        type_list = list(doc_types) if doc_types else [job_type]
        all_runs.append({
            "run_id": run_id,
            "job_id": doc_job_id or run_id,
            "policy_document_id": doc.get("policy_document_id", "") or "",
            "company_name": doc.get("company_name"),
            "run_at": run_at,
            "created_at": run_at,
            "completed_at": run_at,
            "privacy_health_score": doc.get("privacy_health_score"),
            "status": "completed",
            "job_type": job_type,
            "summary": {
                "addressed": summary.get("addressed", 0),
                "partial": summary.get("partial", 0),
                "ambiguous": summary.get("ambiguous", 0),
                "missing": summary.get("missing", 0),
                "conflicts": summary.get("conflicts", 0),
                "total_requirements": total,
            },
            "types": type_list,
            "_source": "compliance_results",
            "_doc": doc,
        })

    runs = [{k: v for k, v in r.items() if not k.startswith("_")} for r in all_runs]

    missing_company_policy_ids = {
        str(r.get("policy_document_id", "")).strip()
        for r in runs
        if not r.get("company_name") and str(r.get("policy_document_id", "")).strip()
    }
    if missing_company_policy_ids:
        policy_docs = _fetch_documents(POLICY_COLLECTION)
        policy_company_by_id: dict[str, str] = {}
        for doc in policy_docs:
            doc_id = str(doc.get("document_id") or doc.get("_id") or "").strip()
            company = str(doc.get("company_name") or "").strip()
            if doc_id and company:
                policy_company_by_id[doc_id] = company
        for r in runs:
            if r.get("company_name"):
                continue
            pid = str(r.get("policy_document_id", "")).strip()
            if pid and policy_company_by_id.get(pid):
                r["company_name"] = policy_company_by_id[pid]

    if policy_document_id:
        runs = [r for r in runs if (r.get("policy_document_id") or "") == policy_document_id]
    if since:
        runs = [r for r in runs if (r.get("run_at") or "") >= since]
    if until:
        runs = [r for r in runs if (r.get("run_at") or "") <= until]
    if types:
        want = {t.strip() for t in types.split(",") if t.strip()}
        def _run_matches_types(r: dict[str, Any]) -> bool:
            run_types = set(r.get("types") or [])
            job_type = r.get("job_type")
            if job_type:
                run_types.add(job_type)
            return bool(want & run_types)
        runs = [r for r in runs if _run_matches_types(r)]

    runs.sort(key=lambda r: r.get("run_at") or "", reverse=True)
    total = len(runs)
    runs = runs[offset : offset + limit]
    return {"runs": runs, "total": total, "limit": limit, "offset": offset}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@bp.route("/api/compliance/jobs", methods=["POST"])
def compliance_create_job() -> Any:
    """Create and start a background compliance job."""
    payload = request.get_json(silent=True) or {}
    job_type = str(payload.get("job_type", "")).strip()
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    if not job_type:
        return jsonify({"error": "job_type is required."}), 400
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400

    if job_type not in ("gap_analysis", "health_score", "multi_jurisdictional", "policy_statute", "risk_assessment"):
        return jsonify({"error": "Unsupported job_type."}), 400

    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409

    applicable_jurisdictions = payload.get("applicable_jurisdictions")
    if isinstance(applicable_jurisdictions, list):
        applicable_jurisdictions = [str(j) for j in applicable_jurisdictions]
    else:
        applicable_jurisdictions = None

    if job_type == "multi_jurisdictional":
        if not applicable_jurisdictions:
            return jsonify({"error": "applicable_jurisdictions (array) is required."}), 400

    if job_type in ("gap_analysis", "health_score", "multi_jurisdictional"):
        config = load_compliance_config()
        index_db = payload.get("index_database_name") or config.get("index_database_name")
        index_coll = payload.get("index_collection_name") or config.get("index_collection_name")
        jurisdictions = applicable_jurisdictions or config.get("default_jurisdictions", ["CA", "VA"])
        statute_guard = assert_statute_indexed_for_jurisdiction(
            forward_get,
            forward_post,
            POLICY_DATABASE,
            STATUTE_COLLECTION,
            STATUTE_CHUNK_COLLECTION,
            jurisdictions,
            index_db,
            index_coll,
            _workflow_collection(),
            use_vector_search=config.get("use_vector_search", False),
        )
        if statute_guard:
            return jsonify(statute_guard), 409

    if job_type == "policy_statute" and not str(payload.get("jurisdiction", "")).strip():
        return jsonify({"error": "jurisdiction is required for policy_statute jobs."}), 400

    job_id = str(uuid.uuid4())
    logger.info("Creating compliance job: type=%s policy=%s job_id=%s", job_type, policy_document_id, job_id)
    job_request: dict[str, Any] = {
        "policy_document_id": policy_document_id,
    }
    if applicable_jurisdictions:
        job_request["applicable_jurisdictions"] = applicable_jurisdictions
    if payload.get("index_database_name"):
        job_request["index_database_name"] = payload.get("index_database_name")
    if payload.get("index_collection_name"):
        job_request["index_collection_name"] = payload.get("index_collection_name")
    if payload.get("model_version"):
        job_request["model_version"] = payload.get("model_version")
    if job_type == "gap_analysis" and payload.get("num_rows") is not None:
        job_request["num_rows"] = payload.get("num_rows")
    if job_type == "policy_statute":
        job_request["jurisdiction"] = str(payload.get("jurisdiction", "")).strip()
        job_request["policy_collection"] = str(payload.get("policy_collection", "")).strip() or POLICY_LEGAL_EMBEDDINGS_COLLECTION
    if job_type == "risk_assessment":
        job_request["template_id"] = str(payload.get("template_id", "default")).strip() or "default"
        job_request["include_report"] = bool(payload.get("include_report", False))

    now = datetime.now(timezone.utc).isoformat()
    _upsert_compliance_job(
        {
            "job_id": job_id,
            "job_type": job_type,
            "status": "pending",
            "created_at": now,
            "completed_at": None,
            "request": job_request,
        }
    )
    threading.Thread(
        target=_run_compliance_job_in_background,
        args=(job_id, job_type, job_request),
        daemon=True,
    ).start()
    return jsonify({"job_id": job_id, "status": "pending", "message": "Compliance job started."}), 202


@bp.route("/api/compliance/policy-statute-compliance", methods=["POST"])
def compliance_policy_statute_compliance() -> Any:
    """Proxy policy-statute compliance to the upstream Web Gather API."""
    payload = request.get_json(silent=True) or {}
    policy_id = str(payload.get("policy_id", "")).strip()
    policy_collection = str(payload.get("policy_collection", "")).strip()
    jurisdiction = str(payload.get("jurisdiction", "")).strip()
    if not policy_id:
        return jsonify({"error": "policy_id is required."}), 400
    if not policy_collection:
        return jsonify({"error": "policy_collection is required."}), 400
    if not jurisdiction:
        return jsonify({"error": "jurisdiction is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    body = {
        "policy_id": policy_id,
        "policy_collection": policy_collection,
        "jurisdiction": jurisdiction,
    }
    data, error = forward_post("/api/compliance/policy-statute-compliance", body)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/compliance/citations", methods=["POST"])
def compliance_citations() -> Any:
    """Proxy statute-policy citation extraction to upstream."""
    payload = request.get_json(silent=True) or {}
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    body = {
        "policy_document_id": policy_document_id,
        "applicable_jurisdictions": payload.get("applicable_jurisdictions"),
    }
    data, error = forward_post("/api/compliance/citations", body)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/compliance/report", methods=["POST"])
def compliance_report() -> Any:
    """Proxy compliance report generation to upstream."""
    payload = request.get_json(silent=True) or {}
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    format_type = str(payload.get("format", "markdown")).strip() or "markdown"
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    body = {
        "policy_document_id": policy_document_id,
        "format": format_type if format_type in ("markdown", "pdf") else "markdown",
        "source": payload.get("source", "latest_stored"),
        "applicable_jurisdictions": payload.get("applicable_jurisdictions"),
        "include_gap": payload.get("include_gap", True),
        "include_health_score": payload.get("include_health_score", True),
        "include_multi_jurisdictional": payload.get("include_multi_jurisdictional", False),
    }
    data, error = forward_post("/api/compliance/report", body)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/compliance/risk-assessment", methods=["POST"])
def compliance_risk_assessment() -> Any:
    """Proxy risk assessment to upstream."""
    payload = request.get_json(silent=True) or {}
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    body = {
        "policy_document_id": policy_document_id,
        "applicable_jurisdictions": payload.get("applicable_jurisdictions"),
        "template_id": payload.get("template_id"),
        "include_report": payload.get("include_report", False),
    }
    data, error = forward_post("/api/compliance/risk-assessment", body, timeout=300)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/compliance/consumer-rights-router", methods=["POST"])
def compliance_consumer_rights_router() -> Any:
    """Proxy consumer rights request router to upstream. Generates decision trees and policy gap analysis."""
    payload = request.get_json(silent=True) or {}
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    body: dict[str, Any] = {
        "policy_document_id": policy_document_id,
    }
    applicable_jurisdictions = payload.get("applicable_jurisdictions")
    if isinstance(applicable_jurisdictions, list):
        body["applicable_jurisdictions"] = [str(j) for j in applicable_jurisdictions]
    if payload.get("request_types"):
        body["request_types"] = payload["request_types"]
    data, error = forward_post("/api/compliance/consumer-rights-router", body, timeout=300)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/compliance/suggest-policy", methods=["POST"])
def compliance_suggest_policy() -> Any:
    """Proxy suggest-policy to upstream. Generates AI-revised policy text to close a compliance gap."""
    payload = request.get_json(silent=True) or {}
    policy_text = str(payload.get("policy_text", "")).strip()
    gap_analysis_text = str(payload.get("gap_analysis_text", "")).strip()
    gap_analysis_match = str(payload.get("gap_analysis_match", "")).strip()
    statute_text = str(payload.get("statute_text", "")).strip()
    if not policy_text or not gap_analysis_text or not gap_analysis_match or not statute_text:
        return jsonify({"error": "policy_text, gap_analysis_text, gap_analysis_match, and statute_text are required."}), 400
    body = {
        "policy_text": policy_text,
        "gap_analysis_text": gap_analysis_text,
        "gap_analysis_match": gap_analysis_match,
        "statute_text": statute_text,
    }
    data, error = forward_post("/api/compliance/suggest-policy", body)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/compliance/risk-assessment/templates", methods=["GET"])
def compliance_risk_assessment_templates() -> Any:
    """Proxy risk assessment templates list to upstream."""
    data, error = forward_get("/api/compliance/risk-assessment/templates", {})
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/compliance/alerts", methods=["GET"])
def compliance_alerts() -> Any:
    """Proxy drift alerts list to upstream."""
    params = {
        "policy_document_id": request.args.get("policy_document_id", ""),
        "company_name": request.args.get("company_name", ""),
        "jurisdiction": request.args.get("jurisdiction", ""),
        "since": request.args.get("since", ""),
        "limit": request.args.get("limit", "50"),
        "offset": request.args.get("offset", "0"),
    }
    params = {k: v for k, v in params.items() if v}
    data, error = forward_get("/api/compliance/alerts", params)
    if error:
        message, status = error
        return jsonify({"error": message}), status
    return jsonify(data)


@bp.route("/api/compliance/runs", methods=["GET"])
def compliance_runs() -> Any:
    """Serve runs from compliance_run_log (local MongoDB) for accurate count and list."""
    limit = int(request.args.get("limit", "50") or "50")
    offset = int(request.args.get("offset", "0") or "0")
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    policy_document_id = str(request.args.get("policy_document_id", "")).strip()
    since = str(request.args.get("since", "")).strip()
    until = str(request.args.get("until", "")).strip()
    types = str(request.args.get("types", "")).strip()
    data = _runs_from_compliance_run_log(
        limit=limit, offset=offset,
        policy_document_id=policy_document_id,
        since=since, until=until, types=types,
    )
    return jsonify(data)


def _is_valid_id(value: str) -> bool:
    """Accept UUID or 24-hex-char MongoDB ObjectId -- reject anything else."""
    import re
    return bool(re.fullmatch(r"[0-9a-fA-F-]{24,36}", value))


@bp.route("/api/compliance/runs/<run_id>", methods=["GET", "DELETE"])
def compliance_run_detail(run_id: str) -> Any:
    """Serve run detail from compliance_run_log. DELETE requires upstream support."""
    if not _is_valid_id(run_id):
        return jsonify({"error": "Invalid run_id format."}), 400

    if request.method == "DELETE":
        data, error = forward_delete(f"/api/compliance/runs/{run_id}", {})
        if error:
            message, status = error
            if status in (404, 405):
                return jsonify({"error": "Delete not supported by upstream."}), 501
            return jsonify({"error": message}), status
        return jsonify(data if data else {"message": "deleted"}), 200

    for collection in (COMPLIANCE_JOBS_COLLECTION, COMPLIANCE_RUN_LOG_COLLECTION, COMPLIANCE_RESULTS_COLLECTION):
        for query in ({"_id": run_id}, {"_id": {"$oid": run_id}}, {"job_id": run_id}, None):
            params: dict[str, Any] = {
                "database_name": POLICY_DATABASE,
                "collection_name": collection,
            }
            if query is not None:
                params["query"] = json.dumps(query)
            data, error = forward_get("/documents", params)
            if error:
                continue
            docs = []
            if isinstance(data, dict):
                docs = data.get("documents", data.get("data", data.get("results", [])))
            if isinstance(docs, list) and docs:
                if query is None:
                    match = next(
                        (d for d in docs if _mongo_id_str(d.get("_id")) == run_id or str(d.get("job_id", "")).strip() == run_id),
                        None,
                    )
                    if match:
                        return jsonify(_run_detail_to_compliance_view(match))
                else:
                    return jsonify(_run_detail_to_compliance_view(docs[0]))
    return jsonify({"error": "Run not found."}), 404


@bp.route("/api/compliance/applicability", methods=["POST"])
def compliance_applicability() -> Any:
    """Determine applicable jurisdictions for a policy (SLM)."""
    payload = request.get_json(silent=True) or {}
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    config = load_compliance_config()
    result = run_applicability(
        forward_post,
        forward_get,
        POLICY_DATABASE,
        POLICY_COLLECTION,
        POLICY_CHUNK_COLLECTION,
        policy_document_id,
    )
    return jsonify(result)


@bp.route("/api/compliance/gap-analysis", methods=["POST"])
def compliance_gap_analysis() -> Any:
    """Run gap analysis: policy vs statute chunks, return gaps and summary."""
    payload = request.get_json(silent=True) or {}
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    applicable_jurisdictions = payload.get("applicable_jurisdictions")
    if isinstance(applicable_jurisdictions, list):
        applicable_jurisdictions = [str(j) for j in applicable_jurisdictions]
    else:
        applicable_jurisdictions = None
    config = load_compliance_config()
    index_db = payload.get("index_database_name") or config.get("index_database_name")
    index_coll = payload.get("index_collection_name") or config.get("index_collection_name")
    jurisdictions = applicable_jurisdictions or config.get("default_jurisdictions", ["CA", "VA"])
    statute_guard = assert_statute_indexed_for_jurisdiction(
        forward_get,
        forward_post,
        POLICY_DATABASE,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        jurisdictions,
        index_db,
        index_coll,
        _workflow_collection(),
        use_vector_search=config.get("use_vector_search", False),
    )
    if statute_guard:
        return jsonify(statute_guard), 409
    save_results = payload.get("save_results", True)
    num_rows = payload.get("num_rows")
    if num_rows is not None:
        try:
            num_rows = int(num_rows)
        except (TypeError, ValueError):
            num_rows = None
    result = run_gap_analysis(
        forward_post,
        forward_get,
        POLICY_DATABASE,
        POLICY_COLLECTION,
        POLICY_CHUNK_COLLECTION,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        policy_document_id,
        applicable_jurisdictions=applicable_jurisdictions,
        config=config,
        index_database_name=index_db,
        index_collection_name=index_coll,
        save_results=save_results,
        num_rows=num_rows,
    )
    gaps = result.get("gaps") or []
    if isinstance(gaps, list):
        result = {**result, "summary": _normalize_gap_summary(gaps, result.get("summary"))}
    if save_results:
        doc = {**result, "run_at": datetime.now(timezone.utc).isoformat()}
        doc["job_type"] = "gap_analysis"
        doc["run_types"] = doc.get("run_types") or ["gap_analysis"]
        if "error" in result:
            doc["compliance_error"] = result["error"]
        if "message" in result:
            doc["compliance_message"] = result["message"]
        _write_compliance_document(COMPLIANCE_RESULTS_COLLECTION, doc)
    return jsonify(result)


@bp.route("/api/compliance/multi-jurisdictional", methods=["POST"])
def compliance_multi_jurisdictional() -> Any:
    """Run strictest common denominator and conflict detection."""
    payload = request.get_json(silent=True) or {}
    applicable_jurisdictions = payload.get("applicable_jurisdictions")
    if not applicable_jurisdictions or not isinstance(applicable_jurisdictions, list):
        return jsonify({"error": "applicable_jurisdictions (array) is required."}), 400
    applicable_jurisdictions = [str(j) for j in applicable_jurisdictions]
    policy_document_id = str(payload.get("policy_document_id", "")).strip() or None
    save_results = bool(payload.get("save_results", True))
    run_id = str(payload.get("run_id", "")).strip() or str(uuid.uuid4())
    model_version = str(payload.get("model_version", "")).strip() or os.getenv("MODEL_VERSION", "unknown")
    config = load_compliance_config()
    index_db = payload.get("index_database_name") or config.get("index_database_name")
    index_coll = payload.get("index_collection_name") or config.get("index_collection_name")
    statute_guard = assert_statute_indexed_for_jurisdiction(
        forward_get,
        forward_post,
        POLICY_DATABASE,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        applicable_jurisdictions,
        index_db,
        index_coll,
        _workflow_collection(),
        use_vector_search=config.get("use_vector_search", False),
    )
    if statute_guard:
        return jsonify(statute_guard), 409
    if policy_document_id:
        guard_err = assert_policy_ready_for_compliance(
            forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
        )
        if guard_err:
            return jsonify(guard_err), 409
    result = run_multi_jurisdictional(
        forward_post,
        forward_get,
        POLICY_DATABASE,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        applicable_jurisdictions,
        policy_document_id=policy_document_id,
        policy_collection=POLICY_COLLECTION,
        policy_chunk_collection=POLICY_CHUNK_COLLECTION,
        config=config,
        index_database_name=index_db,
        index_collection_name=index_coll,
    )
    if save_results:
        _persist_conflict_results(result, run_id=run_id, model_version=model_version)
    return jsonify(result)


@bp.route("/api/compliance/health-score", methods=["POST"])
def compliance_health_score() -> Any:
    """Compute Privacy Health Score (0-100) for a policy."""
    payload = request.get_json(silent=True) or {}
    policy_document_id = str(payload.get("policy_document_id", "")).strip()
    if not policy_document_id:
        return jsonify({"error": "policy_document_id is required."}), 400
    guard_err = assert_policy_ready_for_compliance(
        forward_get, POLICY_DATABASE, policy_document_id, _workflow_collection()
    )
    if guard_err:
        return jsonify(guard_err), 409
    applicable_jurisdictions = payload.get("applicable_jurisdictions")
    if isinstance(applicable_jurisdictions, list):
        applicable_jurisdictions = [str(j) for j in applicable_jurisdictions]
    else:
        applicable_jurisdictions = None
    config = load_compliance_config()
    index_db = payload.get("index_database_name") or config.get("index_database_name")
    index_coll = payload.get("index_collection_name") or config.get("index_collection_name")
    jurisdictions = applicable_jurisdictions or config.get("default_jurisdictions", ["CA", "VA"])
    statute_guard = assert_statute_indexed_for_jurisdiction(
        forward_get,
        forward_post,
        POLICY_DATABASE,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        jurisdictions,
        index_db,
        index_coll,
        _workflow_collection(),
        use_vector_search=config.get("use_vector_search", False),
    )
    if statute_guard:
        return jsonify(statute_guard), 409
    weights = payload.get("weights")
    if isinstance(weights, dict):
        weights = {str(k): float(v) for k, v in weights.items() if isinstance(v, (int, float))}
    else:
        weights = None
    result = run_health_score(
        forward_post,
        forward_get,
        POLICY_DATABASE,
        POLICY_COLLECTION,
        POLICY_CHUNK_COLLECTION,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        policy_document_id,
        applicable_jurisdictions=applicable_jurisdictions,
        gap_result=None,
        config=config,
        index_database_name=index_db,
        index_collection_name=index_coll,
        weights=weights,
    )
    if payload.get("save_results"):
        doc = {**result, "run_at": datetime.now(timezone.utc).isoformat()}
        doc["job_type"] = "health_score"
        doc["run_types"] = doc.get("run_types") or ["health_score"]
        if "error" in result:
            doc["compliance_error"] = result["error"]
        if "message" in result:
            doc["compliance_message"] = result["message"]
        _write_compliance_document(COMPLIANCE_RESULTS_COLLECTION, doc)
    return jsonify(result)


@bp.route("/api/compliance/drift-check", methods=["POST"])
def compliance_drift_check() -> Any:
    """Re-run analysis and emit regulatory drift alerts."""
    payload = request.get_json(silent=True) or {}
    since = str(payload.get("since", "")).strip() or None
    policy_document_ids = payload.get("policy_document_ids")
    if isinstance(policy_document_ids, list):
        policy_document_ids = [str(pid) for pid in policy_document_ids]
    else:
        policy_document_ids = None
    if policy_document_ids is None:
        data, err = forward_get(
            "/documents",
            {
                "database_name": POLICY_DATABASE,
                "collection_name": POLICY_COLLECTION,
            },
        )
        if not err and isinstance(data, dict):
            docs = data.get("documents", data.get("data", data.get("results", [])))
            policy_document_ids = [
                str(d.get("_id") or d.get("document_id", ""))
                for d in (docs or [])
                if d.get("_id") or d.get("document_id")
            ]
    not_ready: list[str] = []
    for pid in policy_document_ids or []:
        guard_err = assert_policy_ready_for_compliance(
            forward_get, POLICY_DATABASE, pid, _workflow_collection()
        )
        if guard_err:
            not_ready.append(pid)
    if not_ready:
        return (
            jsonify({
                "error": "document_not_ready",
                "message": "One or more policies must complete gather, parse, and vector index before drift check.",
                "policy_document_ids": not_ready,
            }),
            409,
        )
    config = load_compliance_config()
    index_db = payload.get("index_database_name") or config.get("index_database_name")
    index_coll = payload.get("index_collection_name") or config.get("index_collection_name")

    def write_alert(alert: dict[str, Any]) -> None:
        _write_compliance_document(COMPLIANCE_ALERTS_COLLECTION, alert)

    result = run_drift_check(
        forward_post,
        forward_get,
        POLICY_DATABASE,
        POLICY_COLLECTION,
        POLICY_CHUNK_COLLECTION,
        STATUTE_COLLECTION,
        STATUTE_CHUNK_COLLECTION,
        results_collection=COMPLIANCE_RESULTS_COLLECTION,
        alerts_collection=COMPLIANCE_ALERTS_COLLECTION,
        since=since,
        policy_document_ids=policy_document_ids,
        config=config,
        index_database_name=index_db,
        index_collection_name=index_coll,
        write_alert=write_alert,
    )
    if payload.get("save_run_log"):
        _write_compliance_document(COMPLIANCE_RUN_LOG_COLLECTION, result)
    return jsonify(result)
