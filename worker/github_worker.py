from __future__ import annotations

import os
import sys
from typing import Any

from kipris_client import KiprisError
from worker import claim_next_job, fail_job, logger, process_job


def env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return min(max(value, minimum), maximum)


def process_one(job: dict[str, Any]) -> None:
    job_id = str(job["id"])
    try:
        process_job(job)
    except (KiprisError, RuntimeError, ValueError) as exc:
        fail_job(job_id, exc)
    except Exception as exc:
        fail_job(job_id, exc)


def main() -> int:
    max_jobs = env_int("MAX_JOBS_PER_RUN", 5, 1, 20)
    processed = 0

    logger.info("GitHub Actions Worker 시작 | 최대 작업=%s", max_jobs)

    while processed < max_jobs:
        job = claim_next_job()
        if not job:
            break

        process_one(job)
        processed += 1

    logger.info("GitHub Actions Worker 종료 | 처리 작업=%s", processed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
