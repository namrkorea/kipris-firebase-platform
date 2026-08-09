from __future__ import annotations

import os

import firebase_admin
from firebase_admin import storage


FIREBASE_STORAGE_BUCKET = os.getenv(
    "FIREBASE_STORAGE_BUCKET",
    "kipris-firebase-platform.firebasestorage.app",
)


def get_storage_bucket():
    try:
        app = firebase_admin.get_app()
    except ValueError:
        app = firebase_admin.initialize_app()

    return storage.bucket(
        FIREBASE_STORAGE_BUCKET,
        app=app,
    )


def upload_pdf(
    storage_path: str,
    pdf_data: bytes,
) -> str:
    bucket = get_storage_bucket()

    blob = bucket.blob(storage_path)

    blob.upload_from_string(
        pdf_data,
        content_type="application/pdf",
    )

    return storage_path