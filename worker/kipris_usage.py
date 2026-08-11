from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
from typing import Any, Callable

import requests
from google.cloud import firestore

try:
    from .firebase_client import get_firestore_client
except ImportError:
    from firebase_client import get_firestore_client


KST = timezone(timedelta(hours=9))
MONTHLY_LIMIT = 1000
_INSTALLED = False
_ORIGINAL_SESSION_GET: Callable[..., Any] | None = None


def _period_key() -> str:
    return datetime.now(KST).strftime("%Y-%m")


def _usage_ref():
    db = get_firestore_client()
    return db.collection("kipris_api_usage").document(_period_key())


def _record_api_call(*, limit_exceeded: bool = False) -> None:
    """Record one actual KIPRIS Open API HTTP response.

    Tracking is intentionally best-effort: a Firestore logging failure must never
    block the patent collection job itself.
    """
    try:
        values: dict[str, Any] = {
            "period": _period_key(),
            "call_count": firestore.Increment(1),
            "monthly_limit": MONTHLY_LIMIT,
            "updated_at": firestore.SERVER_TIMESTAMP,
        }
        if limit_exceeded:
            values["limit_exceeded"] = True
            values["limit_exceeded_at"] = firestore.SERVER_TIMESTAMP
        _usage_ref().set(values, merge=True)
    except Exception as exc:
        print(f"[KIPRIS usage] Firestore 기록 실패: {exc}")


def _is_limit_exceeded_response(response: requests.Response) -> bool:
    try:
        text = response.text
    except Exception:
        return False
    normalized = text.upper()
    return (
        "<RESULTCODE>22</RESULTCODE>" in normalized
        or "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR" in normalized
    )


def install_kipris_usage_counter() -> None:
    """Count actual KIPRIS XML API calls made through requests.Session.get.

    PDF binary downloads are deliberately excluded. Only the configured search,
    detail and PDF-information Open API endpoints are counted.
    """
    global _INSTALLED, _ORIGINAL_SESSION_GET
    if _INSTALLED:
        return

    endpoints = {
        value.strip()
        for value in (
            os.getenv("KIPRIS_SEARCH_URL", ""),
            os.getenv("KIPRIS_DETAIL_URL", ""),
            os.getenv("KIPRIS_PDF_URL", ""),
        )
        if value.strip()
    }
    if not endpoints:
        return

    original_get = requests.Session.get
    _ORIGINAL_SESSION_GET = original_get

    def counted_get(self: requests.Session, url: str, *args: Any, **kwargs: Any):
        response = original_get(self, url, *args, **kwargs)
        if str(url).strip() in endpoints:
            _record_api_call(
                limit_exceeded=_is_limit_exceeded_response(response),
            )
        return response

    requests.Session.get = counted_get  # type: ignore[method-assign]
    _INSTALLED = True
