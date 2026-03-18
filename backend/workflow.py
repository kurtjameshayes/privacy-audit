"""
Document workflow state tracking for privacy policies and statutes.
Ensures documents cannot be processed for compliance until gather, parse, and
vector index steps are complete.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Callable

logger = logging.getLogger(__name__)

# Collection and schema
WORKFLOW_STATE_COLLECTION = "document_workflow_state"
DOCUMENT_TYPES = ("policy", "statute")
WORKFLOW_STEPS = ("gathered", "parsed", "vector_indexed")


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


def _build_step_value(completed: bool) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    return {"completed": completed, "completed_at": now if completed else None}


def get_workflow_state(
    forward_get: Callable[..., tuple[Any, Any]],
    database_name: str,
    document_id: str,
    document_type: str,
    workflow_collection: str = WORKFLOW_STATE_COLLECTION,
) -> dict[str, Any] | None:
    """Fetch workflow state for a document. Returns None if not found."""
    docs = _get_documents(
        forward_get,
        database_name,
        workflow_collection,
        {"document_id": document_id, "document_type": document_type},
    )
    return docs[0] if docs else None


def upsert_workflow_state(
    forward_get: Callable[..., tuple[Any, Any]],
    forward_post: Callable[..., tuple[Any, Any]],
    forward_delete: Callable[..., tuple[Any, Any]],
    database_name: str,
    document_id: str,
    document_type: str,
    step: str,
    workflow_collection: str = WORKFLOW_STATE_COLLECTION,
) -> None:
    """Upsert workflow state, marking the given step as completed."""
    if step not in WORKFLOW_STEPS:
        return
    logger.info("Workflow transition: doc_id=%s type=%s step=%s", document_id, document_type, step)
    now = datetime.now(timezone.utc).isoformat()
    existing = get_workflow_state(
        forward_get, database_name, document_id, document_type, workflow_collection
    )
    steps = {}
    if existing and isinstance(existing.get("steps"), dict):
        steps = dict(existing["steps"])
    steps[step] = _build_step_value(True)
    ready = all(
        steps.get(s, {}).get("completed") for s in WORKFLOW_STEPS
    )
    doc = {
        "document_id": document_id,
        "document_type": document_type,
        "steps": steps,
        "ready_for_compliance": ready,
        "updated_at": now,
    }
    if existing:
        doc["created_at"] = existing.get("created_at", now)
        _, err = forward_delete(
            "/documents",
            {
                "database_name": database_name,
                "collection_name": workflow_collection,
                "query": json.dumps(
                    {"document_id": document_id, "document_type": document_type}
                ),
            },
        )
        if err:
            return
    else:
        doc["created_at"] = now
    forward_post(
        "/write_to_collection",
        {
            "database_name": database_name,
            "collection_name": workflow_collection,
            "document": doc,
            "mode": "append",
        },
    )


def _missing_steps(state: dict[str, Any] | None) -> list[str]:
    if not state or not isinstance(state.get("steps"), dict):
        return list(WORKFLOW_STEPS)
    return [s for s in WORKFLOW_STEPS if not state["steps"].get(s, {}).get("completed")]


def assert_policy_ready_for_compliance(
    forward_get: Callable[..., tuple[Any, Any]],
    database_name: str,
    policy_document_id: str,
    workflow_collection: str = WORKFLOW_STATE_COLLECTION,
) -> dict[str, Any] | None:
    """
    Check policy is ready for compliance. Returns None if ready, else error dict.
    """
    state = get_workflow_state(
        forward_get,
        database_name,
        policy_document_id,
        "policy",
        workflow_collection,
    )
    missing = _missing_steps(state)
    if missing:
        return {
            "error": "document_not_ready",
            "message": f"Policy must complete gather, parse, and vector index before compliance. Missing: {', '.join(missing)}",
            "missing_steps": missing,
        }
    return None


def assert_statute_indexed_for_jurisdiction(
    forward_get: Callable[..., tuple[Any, Any]],
    forward_post: Callable[..., tuple[Any, Any]],
    database_name: str,
    statute_collection: str,
    statute_chunk_collection: str,
    jurisdictions: list[str],
    index_database_name: str | None,
    index_collection_name: str | None,
    workflow_collection: str = WORKFLOW_STATE_COLLECTION,
    use_vector_search: bool = True,
) -> dict[str, Any] | None:
    """
    Check statutes are indexed for the given jurisdictions. Returns None if ready.
    When use_vector_search is False, checks statute documents by jurisdiction only (no vector-search).
    """
    if not jurisdictions:
        return None
    # When vector-search unavailable or not configured, verify statutes exist by jurisdiction
    if not use_vector_search or not index_database_name or not index_collection_name:
        missing_jurisdictions: list[str] = []
        for j in jurisdictions:
            statutes = _get_documents(
                forward_get,
                database_name,
                statute_collection,
                {"jurisdiction": j},
            )
            if not statutes:
                missing_jurisdictions.append(j)
        if missing_jurisdictions:
            return {
                "error": "no_statutes_for_jurisdictions",
                "message": f"No statutes found for jurisdictions: {', '.join(missing_jurisdictions)}",
                "missing_steps": ["gathered", "parsed", "vector_indexed"],
            }
        return None
    missing_jurisdictions = []
    for j in jurisdictions:
        data, err = forward_post(
            "/vector-search",
            {
                "index_database_name": index_database_name,
                "index_collection_name": index_collection_name,
                "query_text": "privacy",
                "filter": {"jurisdiction": j},
                "top_k": 1,
            },
        )
        if err:
            missing_jurisdictions.append(j)
            continue
        chunks = data.get("chunks", data.get("documents", data.get("results", [])))
        if not chunks:
            missing_jurisdictions.append(j)
    if missing_jurisdictions:
        return {
            "error": "statutes_not_indexed",
            "message": f"Statutes must be gathered, parsed, and vector indexed for jurisdictions: {', '.join(missing_jurisdictions)}",
            "missing_jurisdictions": missing_jurisdictions,
            "missing_steps": ["vector_indexed"],
        }
    return None


def backfill_workflow_state(
    forward_get: Callable[..., tuple[Any, Any]],
    forward_post: Callable[..., tuple[Any, Any]],
    forward_delete: Callable[..., tuple[Any, Any]],
    database_name: str,
    policy_collection: str,
    statute_collection: str,
    policy_chunk_collection: str,
    statute_chunk_collection: str,
    policy_index_collection: str,
    statute_index_collection: str,
    workflow_collection: str = WORKFLOW_STATE_COLLECTION,
    use_vector_search: bool = True,
) -> dict[str, Any]:
    """Infer and upsert workflow state for existing documents."""
    results = {"policies": 0, "statutes": 0, "errors": []}
    for doc_type, list_coll, chunk_coll, index_coll in (
        ("policy", policy_collection, policy_chunk_collection, policy_index_collection),
        ("statute", statute_collection, statute_chunk_collection, statute_index_collection),
    ):
        docs = _get_documents(forward_get, database_name, list_coll, None)
        for doc in docs:
            # Prefer stable business key used across APIs/UI; Mongo _id can differ.
            doc_id = str(doc.get("document_id") or doc.get("_id") or "")
            if not doc_id:
                continue
            chunks = _get_documents(
                forward_get,
                database_name,
                chunk_coll,
                {"document_id": doc_id},
            )
            has_chunks = bool(chunks)
            state = get_workflow_state(
                forward_get, database_name, doc_id, doc_type, workflow_collection
            )
            steps = dict(state["steps"]) if state and isinstance(state.get("steps"), dict) else {}
            steps["gathered"] = _build_step_value(True)
            steps["parsed"] = _build_step_value(has_chunks)
            vector_indexed = bool(state and state.get("steps", {}).get("vector_indexed", {}).get("completed"))
            if not vector_indexed and has_chunks:
                if use_vector_search:
                    try:
                        data, _ = forward_post(
                            "/vector-search",
                            {
                                "index_database_name": database_name,
                                "index_collection_name": index_coll,
                                "query_text": "privacy",
                                "filter": {"document_id": doc_id},
                                "top_k": 1,
                            },
                        )
                        chunks_found = data.get("chunks", data.get("documents", data.get("results", [])))
                        vector_indexed = bool(chunks_found)
                    except Exception:
                        pass
                else:
                    vector_indexed = True
            steps["vector_indexed"] = _build_step_value(vector_indexed)
            ready = all(steps.get(s, {}).get("completed") for s in WORKFLOW_STEPS)
            now = datetime.now(timezone.utc).isoformat()
            wf_doc = {
                "document_id": doc_id,
                "document_type": doc_type,
                "steps": steps,
                "ready_for_compliance": ready,
                "created_at": (state or {}).get("created_at", now),
                "updated_at": now,
            }
            if state:
                forward_delete(
                    "/documents",
                    {
                        "database_name": database_name,
                        "collection_name": workflow_collection,
                        "query": json.dumps(
                            {"document_id": doc_id, "document_type": doc_type}
                        ),
                    },
                )
            forward_post(
                "/write_to_collection",
                {
                    "database_name": database_name,
                    "collection_name": workflow_collection,
                    "document": wf_doc,
                    "mode": "append",
                },
            )
            if doc_type == "policy":
                results["policies"] += 1
            else:
                results["statutes"] += 1
    return results
