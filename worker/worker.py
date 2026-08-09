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


from .kipris_client import KiprisClient, KiprisConfig, KiprisError


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
    try:
        from .firebase_repository import claim_next_job as firebase_claim_next_job
    except ImportError:
        from firebase_repository import claim_next_job as firebase_claim_next_job

    return firebase_claim_next_job()



def update_job(job_id: str, values: dict[str, Any]) -> None:
    try:
        from .firebase_repository import update_job as firebase_update_job
    except ImportError:
        from firebase_repository import update_job as firebase_update_job

    firebase_update_job(job_id, values)


def safe_application_number(value: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z_-]+", "", value)
    return cleaned[:80] or "unknown"


def clean_error_message(exc: Exception) -> str:
    value = re.sub(r"<[^>]+>", " ", str(exc))
    value = re.sub(r"\s+", " ", value).strip()
    return value[:220] or exc.__class__.__name__





def bulk_save_search_results(
    job_id: str,
    items: list[dict[str, Any]],
) -> dict[str, str]:
    try:
        from .firebase_repository import (
            bulk_save_search_results as firebase_bulk_save_search_results,
        )
    except ImportError:
        from firebase_repository import (
            bulk_save_search_results as firebase_bulk_save_search_results,
        )

    return firebase_bulk_save_search_results(
        job_id,
        items,
    )


def save_detail_xml(patent_id: str, application_number: str) -> None:
    detail_xml = kipris.get_detail_xml(application_number)

    try:
        from .firebase_repository import save_detail_xml as firebase_save_detail_xml
    except ImportError:
        from firebase_repository import save_detail_xml as firebase_save_detail_xml

    firebase_save_detail_xml(
        patent_id,
        detail_xml,
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

    try:
        from .firebase_storage import upload_pdf as firebase_upload_pdf
        from .firebase_repository import save_pdf_info as firebase_save_pdf_info
    except ImportError:
        from firebase_storage import upload_pdf as firebase_upload_pdf
        from firebase_repository import save_pdf_info as firebase_save_pdf_info

    storage_path = firebase_upload_pdf(
        requested_path,
        pdf_data,
    )

    firebase_save_pdf_info(
        patent_id,
        storage_path,
        safe_name,
        len(pdf_data),
    )

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
