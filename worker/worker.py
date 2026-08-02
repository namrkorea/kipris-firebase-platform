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

            # Existing object or gateway-specific 400: try explicit replacement.
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

    # Final fallback: use a short unique path to avoid path/existing-object issues.
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

def upsert_patent(
    item: dict[str, Any],
    *,
    requested_by: str | None,
    detail_xml: str,
) -> str:
    record = {
        **item,
        "detail_xml": detail_xml,
        "is_public": True,
    }
    if requested_by:
        record["first_collected_by"] = requested_by

    response = (
        supabase.table("patents")
        .upsert(record, on_conflict="application_number")
        .execute()
    )
    data = response.data or []
    if data and data[0].get("id"):
        return str(data[0]["id"])

    lookup = (
        supabase.table("patents")
        .select("id")
        .eq("application_number", item["application_number"])
        .single()
        .execute()
    )
    if not lookup.data or not lookup.data.get("id"):
        raise RuntimeError("저장한 특허 ID를 확인할 수 없습니다.")
    return str(lookup.data["id"])


def save_job_patent(job_id: str, patent_id: str, order: int) -> None:
    (
        supabase.table("job_patents")
        .upsert(
            {
                "job_id": job_id,
                "patent_id": patent_id,
                "display_order": order,
            },
            on_conflict="job_id,patent_id",
        )
        .execute()
    )


def save_pdf(
    *,
    patent_id: str,
    application_number: str,
    document_name: str,
    source_url: str,
) -> str:
    pdf_data, _ = kipris.download_pdf(source_url, MAX_PDF_BYTES)
    safe_app = safe_application_number(application_number)
    safe_name = f"{safe_app}.pdf"
    requested_path = f"{safe_app}/{safe_name}"
    storage_path = upload_pdf(requested_path, pdf_data)

    (
        supabase.table("patent_documents")
        .upsert(
            {
                "patent_id": patent_id,
                "document_type": "publication_pdf",
                "storage_bucket": PDF_BUCKET,
                "storage_path": storage_path,
                "original_name": safe_name,
                "byte_size": len(pdf_data),
            },
            on_conflict="patent_id,document_type",
        )
        .execute()
    )

    (
        supabase.table("patents")
        .update({"pdf_storage_path": storage_path})
        .eq("id", patent_id)
        .execute()
    )

    return storage_path


def process_job(job: dict[str, Any]) -> None:
    job_id = str(job["id"])
    raw_requested_by = job.get("requested_by")
    requested_by = str(raw_requested_by) if raw_requested_by else None
    query_text = str(job["query_text"])
    search_field = str(job["search_field"])
    max_results = int(job["max_results"])
    download_pdf = bool(job["download_pdf"])

    logger.info(
        "작업 시작 | id=%s | field=%s | query=%s",
        job_id,
        search_field,
        query_text,
    )

    items = kipris.search(
        search_field=search_field,
        query_text=query_text,
        max_results=max_results,
    )

    update_job(
        job_id,
        {
            "progress_total": len(items),
            "progress_current": 0,
            "result_count": 0,
        },
    )

    saved_count = 0
    pdf_saved_count = 0
    item_errors: list[str] = []
    warnings: list[str] = []

    for index, item in enumerate(items, start=1):
        application_number = item["application_number"]
        try:
            detail_xml = ""
            try:
                detail_xml = kipris.get_detail_xml(application_number)
            except Exception as exc:
                logger.warning(
                    "상세정보 수집 경고 | application=%s | %s",
                    application_number,
                    clean_error_message(exc),
                )
                warnings.append(f"{application_number}: 상세정보 일부 누락")

            patent_id = upsert_patent(
                item,
                requested_by=requested_by,
                detail_xml=detail_xml,
            )
            save_job_patent(job_id, patent_id, index)
            saved_count += 1

            if download_pdf:
                try:
                    pdf_info = kipris.get_pdf_info(application_number)
                    if pdf_info:
                        document_name, source_url = pdf_info
                        save_pdf(
                            patent_id=patent_id,
                            application_number=application_number,
                            document_name=document_name,
                            source_url=source_url,
                        )
                        pdf_saved_count += 1
                except Exception as exc:
                    logger.exception(
                        "PDF 처리 경고 | application=%s",
                        application_number,
                    )
                    warnings.append(f"{application_number}: PDF 저장 실패")
        except Exception as exc:
            logger.exception(
                "개별 특허 저장 실패 | application=%s",
                application_number,
            )
            item_errors.append(
                f"{application_number}: {clean_error_message(exc)}"
            )

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

    status = "completed" if saved_count > 0 or not items else "failed"
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
