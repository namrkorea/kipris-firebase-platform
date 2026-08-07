from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import logging
import os
import re
import socket
import sys
import time
from typing import Any
from urllib.parse import quote

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

from kipris_client import KiprisClient, KiprisConfig, KiprisError


load_dotenv()

LOG_FORMAT = "%(asctime)s | %(levelname)s | %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
logger = logging.getLogger("kipris-worker")


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"환경변수 {name}이 비어 있습니다.")
    return value


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return min(max(value, minimum), maximum)


SUPABASE_URL = required_env("SUPABASE_URL")
SUPABASE_SECRET_KEY = required_env("SUPABASE_SECRET_KEY")
KIPRIS_SERVICE_KEY = required_env("KIPRIS_SERVICE_KEY")

WORKER_ID = os.getenv(
    "WORKER_ID",
    f"{socket.gethostname()}-{os.getpid()}",
).strip()
POLL_SECONDS = max(float(os.getenv("POLL_SECONDS", "5")), 1.0)
REQUEST_INTERVAL = max(
    float(os.getenv("KIPRIS_REQUEST_INTERVAL", "0.6")),
    0.1,
)
REQUEST_TIMEOUT = max(int(os.getenv("REQUEST_TIMEOUT", "90")), 10)
KIPRIS_MAX_RETRIES = min(max(int(os.getenv("KIPRIS_MAX_RETRIES", "4")), 1), 8)
KIPRIS_RETRY_BACKOFF = max(float(os.getenv("KIPRIS_RETRY_BACKOFF", "2.0")), 0.5)
STORAGE_MAX_RETRIES = min(max(int(os.getenv("STORAGE_MAX_RETRIES", "3")), 1), 6)
PDF_BUCKET = os.getenv("PDF_BUCKET", "patent-pdfs").strip()
MAX_PDF_BYTES = min(
    max(int(os.getenv("MAX_PDF_BYTES", "52428800")), 1_000_000),
    100_000_000,
)
FETCH_DETAIL_XML = env_bool("FETCH_DETAIL_XML", False)
PROGRESS_UPDATE_EVERY = env_int("PROGRESS_UPDATE_EVERY", 5, 1, 100)

supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
)

kipris = KiprisClient(
    KiprisConfig(
        service_key=KIPRIS_SERVICE_KEY,
        search_url=required_env("KIPRIS_SEARCH_URL"),
        detail_url=required_env("KIPRIS_DETAIL_URL"),
        pdf_url=required_env("KIPRIS_PDF_URL"),
        interval=REQUEST_INTERVAL,
        timeout=REQUEST_TIMEOUT,
        max_retries=KIPRIS_MAX_RETRIES,
        retry_backoff=KIPRIS_RETRY_BACKOFF,
    )
)


def claim_next_job() -> dict[str, Any] | None:
    response = supabase.rpc(
        "claim_next_collection_job",
        {"p_worker_id": WORKER_ID},
    ).execute()
    rows = response.data or []
    return rows[0] if rows else None


def update_job(job_id: str, values: dict[str, Any]) -> None:
    supabase.table("collection_jobs").update(values).eq("id", job_id).execute()


def safe_application_number(value: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z_-]+", "", value)
    return cleaned[:80] or "unknown"


def clean_error_message(exc: Exception) -> str:
    value = re.sub(r"<[^>]+>", " ", str(exc))
    value = re.sub(r"\s+", " ", value).strip()
    return value[:220] or exc.__class__.__name__


def _storage_request(method: str, url: str, data: bytes) -> requests.Response:
    headers = {
        "apikey": SUPABASE_SECRET_KEY,
        "Content-Type": "application/pdf",
        "x-upsert": "true",
    }
    return requests.request(
        method,
        url,
        headers=headers,
        data=data,
        timeout=max(REQUEST_TIMEOUT, 120),
    )


def upload_pdf(path: str, data: bytes) -> str:
    encoded_path = "/".join(quote(part, safe="") for part in path.split("/"))
    base_url = (
        f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/"
        f"{quote(PDF_BUCKET, safe='')}/{encoded_path}"
    )
    last_error = ""

    for attempt in range(1, STORAGE_MAX_RETRIES + 1):
        try:
            response = _storage_request("POST", base_url, data)
            if response.status_code < 400:
                return path

            if response.status_code == 400:
                update_response = _storage_request("PUT", base_url, data)
                if update_response.status_code < 400:
                    return path
                last_error = (
                    f"POST 400 / PUT {update_response.status_code}: "
                    f"{clean_error_message(RuntimeError(update_response.text))}"
                )
            else:
                last_error = (
                    f"HTTP {response.status_code}: "
                    f"{clean_error_message(RuntimeError(response.text))}"
                )

            if response.status_code not in {400, 408, 425, 429, 500, 502, 503, 504}:
                break
        except requests.RequestException as exc:
            last_error = clean_error_message(exc)

        if attempt < STORAGE_MAX_RETRIES:
            time.sleep(min(2 ** attempt, 8))

    digest = hashlib.sha256(data).hexdigest()[:12]
    fallback_path = f"fallback/{digest}.pdf"
    fallback_url = (
        f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/"
        f"{quote(PDF_BUCKET, safe='')}/fallback/{digest}.pdf"
    )
    try:
        fallback_response = _storage_request("POST", fallback_url, data)
        if fallback_response.status_code < 400:
            return fallback_path
        last_error = (
            f"{last_error}; fallback HTTP {fallback_response.status_code}: "
            f"{clean_error_message(RuntimeError(fallback_response.text))}"
        )
    except requests.RequestException as exc:
        last_error = f"{last_error}; fallback: {clean_error_message(exc)}"

    raise RuntimeError(f"Supabase Storage 업로드 실패(재시도 후 중단): {last_error}")


def bulk_save_search_results(
    job_id: str,
    items: list[dict[str, Any]],
) -> dict[str, str]:
    response = supabase.rpc(
        "bulk_save_patent_results",
        {
            "p_job_id": job_id,
            "p_patents": items,
        },
    ).execute()

    rows = response.data or []
    patent_ids = {
        str(row["application_number"]): str(row["patent_id"])
        for row in rows
        if row.get("application_number") and row.get("patent_id")
    }

    if len(patent_ids) < len(items):
        application_numbers = [
            str(item["application_number"])
            for item in items
            if item.get("application_number")
        ]
        if application_numbers:
            lookup = (
                supabase.table("patents")
                .select("id,application_number")
                .in_("application_number", application_numbers)
                .execute()
            )
            for row in lookup.data or []:
                if row.get("application_number") and row.get("id"):
                    patent_ids[str(row["application_number"])] = str(row["id"])

    return patent_ids


def save_detail_xml(patent_id: str, application_number: str) -> None:
    detail_xml = kipris.get_detail_xml(application_number)
    (
        supabase.table("patents")
        .update({"detail_xml": detail_xml})
        .eq("id", patent_id)
        .execute()
    )


def save_pdf(
    *,
    patent_id: str,
    application_number: str,
    source_url: str,
) -> str:
    pdf_data, _ = kipris.download_pdf(source_url, MAX_PDF_BYTES)
    safe_app = safe_application_number(application_number)
    safe_name = f"{safe_app}.pdf"
    requested_path = f"{safe_app}/{safe_name}"
    storage_path = upload_pdf(requested_path, pdf_data)

    supabase.rpc(
        "record_patent_pdf",
        {
            "p_patent_id": patent_id,
            "p_storage_bucket": PDF_BUCKET,
            "p_storage_path": storage_path,
            "p_original_name": safe_name,
            "p_byte_size": len(pdf_data),
        },
    ).execute()

    return storage_path


def process_job(job: dict[str, Any]) -> None:
    job_id = str(job["id"])
    query_text = str(job["query_text"])
    search_field = str(job["search_field"])
    max_results = int(job["max_results"])
    download_pdf = bool(job["download_pdf"])

    logger.info(
        "작업 시작 | id=%s | field=%s | query=%s | detail=%s | pdf=%s",
        job_id,
        search_field,
        query_text,
        FETCH_DETAIL_XML,
        download_pdf,
    )

    items = kipris.search(
        search_field=search_field,
        query_text=query_text,
        max_results=max_results,
    )

    patent_ids = bulk_save_search_results(job_id, items)
    saved_count = len(patent_ids)

    if not items:
        update_job(
            job_id,
            {
                "status": "completed",
                "progress_current": 0,
                "progress_total": 0,
                "result_count": 0,
                "error_message": None,
                "completed_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        logger.info("작업 완료 | id=%s | 검색 결과=0", job_id)
        return

    if not FETCH_DETAIL_XML and not download_pdf:
        update_job(
            job_id,
            {
                "status": "completed",
                "progress_current": len(items),
                "progress_total": len(items),
                "result_count": saved_count,
                "error_message": None,
                "completed_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        logger.info(
            "작업 완료 | id=%s | 특허=%s | 상세/PDF 후처리 없음",
            job_id,
            saved_count,
        )
        return

    pdf_saved_count = 0
    item_errors: list[str] = []
    warnings: list[str] = []

    for index, item in enumerate(items, start=1):
        application_number = str(item["application_number"])
        patent_id = patent_ids.get(application_number)

        if not patent_id:
            item_errors.append(f"{application_number}: 저장된 특허 ID 확인 실패")
            continue

        if FETCH_DETAIL_XML:
            try:
                save_detail_xml(patent_id, application_number)
            except Exception as exc:
                logger.warning(
                    "상세정보 수집 경고 | application=%s | %s",
                    application_number,
                    clean_error_message(exc),
                )
                warnings.append(f"{application_number}: 상세정보 일부 누락")

        if download_pdf:
            try:
                pdf_info = kipris.get_pdf_info(application_number)
                if pdf_info:
                    _, source_url = pdf_info
                    save_pdf(
                        patent_id=patent_id,
                        application_number=application_number,
                        source_url=source_url,
                    )
                    pdf_saved_count += 1
            except Exception:
                logger.exception(
                    "PDF 처리 경고 | application=%s",
                    application_number,
                )
                warnings.append(f"{application_number}: PDF 저장 실패")

        if index % PROGRESS_UPDATE_EVERY == 0 or index == len(items):
            update_job(
                job_id,
                {
                    "progress_current": index,
                    "result_count": saved_count,
                },
            )

    summary_parts: list[str] = []
    if warnings:
        summary_parts.append(
            f"부가자료 경고 {len(warnings)}건(PDF 또는 상세정보). 특허 목록은 저장되었습니다."
        )
    if item_errors:
        summary_parts.append(f"특허 저장 실패 {len(item_errors)}건.")
    if warnings or item_errors:
        details = (warnings + item_errors)[:5]
        summary_parts.append(" / ".join(details))

    status = "completed" if saved_count > 0 else "failed"
    update_job(
        job_id,
        {
            "status": status,
            "progress_current": len(items),
            "progress_total": len(items),
            "result_count": saved_count,
            "error_message": " ".join(summary_parts)[:1000] or None,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    logger.info(
        "작업 완료 | id=%s | 특허=%s | PDF=%s | 경고=%s | 실패=%s",
        job_id,
        saved_count,
        pdf_saved_count,
        len(warnings),
        len(item_errors),
    )


def fail_job(job_id: str, exc: Exception) -> None:
    message = str(exc).strip() or exc.__class__.__name__
    logger.exception("작업 실패 | id=%s", job_id)
    update_job(
        job_id,
        {
            "status": "failed",
            "error_message": message[:1000],
            "completed_at": datetime.now(timezone.utc).isoformat(),
        },
    )


def main() -> int:
    logger.info("Worker 시작 | id=%s", WORKER_ID)

    while True:
        try:
            job = claim_next_job()
            if not job:
                time.sleep(POLL_SECONDS)
                continue

            job_id = str(job["id"])
            try:
                process_job(job)
            except (KiprisError, RuntimeError, ValueError) as exc:
                fail_job(job_id, exc)
            except Exception as exc:
                fail_job(job_id, exc)
        except KeyboardInterrupt:
            logger.info("Worker 종료")
            return 0
        except Exception:
            logger.exception("Worker 루프 오류")
            time.sleep(max(POLL_SECONDS, 5.0))


if __name__ == "__main__":
    sys.exit(main())
