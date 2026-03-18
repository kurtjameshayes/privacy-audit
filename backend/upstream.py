"""Consolidated upstream API proxy – single request function with thin typed wrappers."""

from __future__ import annotations

import logging
from typing import Any, Literal, Tuple

import requests

from backend.config import API_BASE_URL, FIRECRAWL_API_KEY

logger = logging.getLogger(__name__)


def api_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if FIRECRAWL_API_KEY:
        headers["Authorization"] = f"Bearer {FIRECRAWL_API_KEY}"
    return headers


def _forward_request(
    method: Literal["GET", "POST", "DELETE"],
    endpoint: str,
    *,
    params: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
    timeout: int = 60,
) -> Tuple[Any, Tuple[str, int] | None]:
    """Send a request to the upstream Web Gather API and return (data, error)."""
    if not API_BASE_URL:
        return None, ("GATHER_API_BASE_URL is not set.", 500)
    if not FIRECRAWL_API_KEY:
        return None, ("FIRECRAWL_API_KEY is not set.", 500)

    url = f"{API_BASE_URL.rstrip('/')}/{endpoint.lstrip('/')}"
    try:
        response = requests.request(
            method,
            url,
            json=payload if method in ("POST",) else None,
            params=params if method in ("GET", "DELETE") else None,
            headers=api_headers(),
            timeout=timeout,
        )
    except requests.RequestException:
        return None, (
            "Upstream service unavailable. Check that the service at GATHER_API_BASE_URL is running.",
            502,
        )

    if response.status_code >= 400:
        try:
            message = response.json().get("error", response.text)
        except ValueError:
            message = response.text
        return None, (message, response.status_code)

    try:
        return response.json(), None
    except ValueError:
        return {"raw": response.text}, None


def forward_post(
    endpoint: str, payload: dict[str, Any], timeout: int = 60
) -> Tuple[Any, Tuple[str, int] | None]:
    return _forward_request("POST", endpoint, payload=payload, timeout=timeout)


def forward_get(
    endpoint: str, params: dict[str, Any]
) -> Tuple[Any, Tuple[str, int] | None]:
    return _forward_request("GET", endpoint, params=params)


def forward_delete(
    endpoint: str, params: dict[str, Any]
) -> Tuple[Any, Tuple[str, int] | None]:
    return _forward_request("DELETE", endpoint, params=params)
