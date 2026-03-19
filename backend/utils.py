"""Shared utilities for the backend."""

from __future__ import annotations

import json
import logging
from typing import Any, Callable

logger = logging.getLogger(__name__)


def strip_dollar_keys(obj: Any) -> Any:
    """Recursively remove keys starting with '$' to prevent NoSQL injection."""
    if isinstance(obj, dict):
        return {k: strip_dollar_keys(v) for k, v in obj.items() if not k.startswith("$")}
    if isinstance(obj, list):
        return [strip_dollar_keys(item) for item in obj]
    return obj


def get_documents(
    forward_get: Callable[..., tuple[Any, Any]],
    database_name: str,
    collection_name: str,
    query: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Return list of documents from the upstream API."""
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
