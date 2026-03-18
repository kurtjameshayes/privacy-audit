"""Consolidated upstream API proxy – single request function with thin typed wrappers."""

from __future__ import annotations

import logging
from typing import Any, Literal

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from backend.config import API_BASE_URL, FIRECRAWL_API_KEY

logger = logging.getLogger(__name__)

_retry_strategy = Retry(
    total=3,
    backoff_factor=0.5,
    status_forcelist=[502, 503, 504],
    allowed_methods=["GET", "POST", "DELETE"],
)
_adapter = HTTPAdapter(max_retries=_retry_strategy)

_session = requests.Session()
_session.mount("http://", _adapter)
_session.mount("https://", _adapter)


def api_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if FIRECRAWL_API_KEY:
        headers["Authorization"] = f"Bearer {FIRECRAWL_API_KEY}"
    return headers


_UPSTREAM_ERROR_MAP: dict[int, str] = {
    400: "Bad request to upstream service.",
    401: "Upstream authentication failed.",
    403: "Upstream authorization denied.",
    404: "Upstream resource not found.",
    429: "Upstream rate limit exceeded.",
    500: "Upstream internal error.",
    502: "Upstream service unavailable.",
    503: "Upstream service unavailable.",
    504: "Upstream request timed out.",
}


def _sanitize_upstream_error(raw: str, status_code: int) -> str:
    """Return a user-safe error message that hides internal upstream details."""
    if status_code in _UPSTREAM_ERROR_MAP:
        return _UPSTREAM_ERROR_MAP[status_code]
    return f"Upstream error (HTTP {status_code})."


def _forward_request(
    method: Literal["GET", "POST", "DELETE"],
    endpoint: str,
    *,
    params: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
    timeout: int = 60,
) -> tuple[Any, tuple[str, int] | None]:
    """Send a request to the upstream Web Gather API and return (data, error)."""
    if not API_BASE_URL:
        return None, ("Upstream API is not configured.", 500)
    if not FIRECRAWL_API_KEY:
        return None, ("Upstream API credentials are not configured.", 500)

    url = f"{API_BASE_URL.rstrip('/')}/{endpoint.lstrip('/')}"
    try:
        response = _session.request(
            method,
            url,
            json=payload if method in ("POST",) else None,
            params=params if method in ("GET", "DELETE") else None,
            headers=api_headers(),
            timeout=timeout,
        )
    except requests.RequestException as exc:
        logger.error("Upstream request failed: %s %s — %s", method, url, exc)
        return None, (
            "Upstream service unavailable.",
            502,
        )

    if response.status_code >= 400:
        try:
            raw_message = response.json().get("error", response.text)
        except ValueError:
            raw_message = response.text
        logger.warning("Upstream %s %s returned %d: %s", method, url, response.status_code, raw_message)
        safe_message = _sanitize_upstream_error(str(raw_message), response.status_code)
        return None, (safe_message, response.status_code)

    try:
        return response.json(), None
    except ValueError:
        return {"raw": response.text}, None


def forward_post(
    endpoint: str, payload: dict[str, Any], timeout: int = 60
) -> tuple[Any, tuple[str, int] | None]:
    return _forward_request("POST", endpoint, payload=payload, timeout=timeout)


def forward_get(
    endpoint: str, params: dict[str, Any]
) -> tuple[Any, tuple[str, int] | None]:
    return _forward_request("GET", endpoint, params=params)


def forward_delete(
    endpoint: str, params: dict[str, Any]
) -> tuple[Any, tuple[str, int] | None]:
    return _forward_request("DELETE", endpoint, params=params)
