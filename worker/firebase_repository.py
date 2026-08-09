from __future__ import annotations

from typing import Any

try:
    from .firebase_client import get_firestore_client
except ImportError:
    from firebase_client import get_firestore_client


db = get_firestore_client()


def update_job(job_id: str, values: dict[str, Any]) -> None:
    db.collection("collection_jobs").document(job_id).set(
        values,
        merge=True,
    )


def get_job(job_id: str) -> dict[str, Any] | None:
    doc = db.collection("collection_jobs").document(job_id).get()

    if not doc.exists:
        return None

    data = doc.to_dict() or {}
    data["id"] = doc.id
    return data


def claim_next_job() -> dict[str, Any] | None:
    jobs_ref = db.collection("collection_jobs")

    docs = list(
        jobs_ref
        .where("status", "==", "queued")
        .limit(1)
        .stream()
    )

    if not docs:
        return None

    doc = docs[0]
    job_ref = doc.reference

    transaction = db.transaction()

    from google.cloud import firestore

    @firestore.transactional
    def claim(transaction):
        snapshot = job_ref.get(transaction=transaction)

        if not snapshot.exists:
            return None

        data = snapshot.to_dict() or {}

        if data.get("status") != "queued":
            return None

        transaction.update(
            job_ref,
            {
                "status": "processing",
                "started_at": firestore.SERVER_TIMESTAMP,
            },
        )

        data["id"] = snapshot.id
        data["status"] = "processing"

        return data

    return claim(transaction)

def bulk_save_search_results(
    job_id: str,
    items: list[dict[str, Any]],
) -> dict[str, str]:
    import hashlib
    from google.cloud import firestore

    patent_ids: dict[str, str] = {}

    batch = db.batch()
    write_count = 0

    for item in items:
        application_number = str(
            item.get("application_number") or ""
        ).strip()

        if not application_number:
            continue

        patent_id = hashlib.sha256(
            application_number.encode("utf-8")
        ).hexdigest()[:40]

        patent_ref = db.collection("patents").document(patent_id)

        result_ref = (
            db.collection("collection_jobs")
            .document(job_id)
            .collection("results")
            .document(patent_id)
        )

        patent_data = dict(item)
        patent_data["application_number"] = application_number
        patent_data["updated_at"] = firestore.SERVER_TIMESTAMP

        batch.set(
            patent_ref,
            patent_data,
            merge=True,
        )

        batch.set(
            result_ref,
            {
                "patent_id": patent_id,
                "application_number": application_number,
                "saved_at": firestore.SERVER_TIMESTAMP,
            },
            merge=True,
        )

        patent_ids[application_number] = patent_id
        write_count += 2

        if write_count >= 400:
            batch.commit()
            batch = db.batch()
            write_count = 0

    if write_count:
        batch.commit()

    return patent_ids

def save_detail_xml(
    patent_id: str,
    detail_xml: str,
) -> None:
    db.collection("patents").document(patent_id).set(
        {
            "detail_xml": detail_xml,
        },
        merge=True,
    )

def save_pdf_info(
    patent_id: str,
    storage_path: str,
    original_name: str,
    byte_size: int,
) -> None:
    db.collection("patents").document(patent_id).set(
        {
            "pdf_storage_path": storage_path,
            "pdf_original_name": original_name,
            "pdf_byte_size": byte_size,
        },
        merge=True,
    )