from __future__ import annotations

from dataclasses import dataclass
import json
import random
import re
import threading
import time
from typing import Any
from urllib.parse import urlparse
import xml.etree.ElementTree as ET

import requests


class KiprisError(RuntimeError):
    pass


class KiprisRateLimitError(KiprisError):
    pass


_API_RATE_LOCK = threading.Lock()
_API_LAST_REQUEST_AT = 0.0


def _wait_shared_api_rate_limit(interval: float) -> None:
    global _API_LAST_REQUEST_AT

    with _API_RATE_LOCK:
        elapsed = time.monotonic() - _API_LAST_REQUEST_AT
        wait = max(interval, 0.0) - elapsed
        if wait > 0:
            time.sleep(wait)
        _API_LAST_REQUEST_AT = time.monotonic()


def _local_name(tag: str) -> str:
    return tag.split("}", 1)[-1]


def _element_to_value(element: ET.Element) -> Any:
    children = list(element)
    if not children:
        return (element.text or "").strip()

    grouped: dict[str, list[Any]] = {}
    for child in children:
        grouped.setdefault(_local_name(child.tag), []).append(
            _element_to_value(child)
        )

    result: dict[str, Any] = {}
    for key, values in grouped.items():
        result[key] = values[0] if len(values) == 1 else values
    return result


def _find_text(root: ET.Element, name: str) -> str:
    for element in root.iter():
        if _local_name(element.tag) == name:
            return (element.text or "").strip()
    return ""


def _find_items(root: ET.Element) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for element in root.iter():
        if _local_name(element.tag) != "item":
            continue
        value = _element_to_value(element)
        if isinstance(value, dict):
            items.append(value)
    return items


def _first_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return _first_value(value[0]) if value else ""
    if isinstance(value, dict):
        for candidate in ("name", "text", "#text"):
            if candidate in value:
                return _first_value(value[candidate])
        return json.dumps(value, ensure_ascii=False)
    return str(value).strip()


def _year_month(value: str) -> str:
    digits = "".join(character for character in str(value) if character.isdigit())
    return digits[:6] if len(digits) >= 6 else ""


def _normalize_text(value: str) -> str:
    return " ".join(str(value or "").strip().split()).casefold()


def _normalize_identifier(value: str) -> str:
    return "".join(character for character in str(value or "") if character.isalnum()).casefold()


def _split_people(value: str) -> list[str]:
    return [
        _normalize_text(part)
        for part in re.split(r"[;,|/\n]+", str(value or ""))
        if _normalize_text(part)
    ]


def _ipc_tokens(value: str) -> set[str]:
    normalized = str(value or "").upper()
    tokens = re.findall(r"[A-HY]\d{2}[A-Z]\s*\d+(?:/\d+)?", normalized)
    return {_normalize_identifier(token) for token in tokens}


def _contains_exact_term(value: str, query: str) -> bool:
    haystack = _normalize_text(value)
    needle = _normalize_text(query)
    if not haystack or not needle:
        return False
    return needle in haystack


def _matches_exact_search(
    patent: dict[str, Any],
    search_field: str,
    query_text: str,
) -> bool:
    query = str(query_text or "").strip()
    if not query:
        return False

    if search_field == "word":
        return _contains_exact_term(str(patent.get("invention_title") or ""), query) or _contains_exact_term(
            str(patent.get("abstract") or ""), query
        )

    if search_field == "inventionTitle":
        return _contains_exact_term(str(patent.get("invention_title") or ""), query)

    if search_field == "applicant":
        return _contains_exact_term(str(patent.get("applicant_name") or ""), query)

    if search_field == "ipcNumber":
        requested = [part.strip() for part in re.split(r"\s*\+\s*", query) if part.strip()]
        requested_tokens = {_normalize_identifier(part) for part in requested}
        actual_tokens = _ipc_tokens(str(patent.get("ipc_number") or ""))
        return bool(requested_tokens) and requested_tokens.issubset(actual_tokens)

    field_map = {
        "applicationNumber": "application_number",
        "publicationNumber": "publication_number",
        "registerNumber": "register_number",
    }
    patent_key = field_map.get(search_field)
    if patent_key:
        return _normalize_identifier(str(patent.get(patent_key) or "")) == _normalize_identifier(query)

    return False


def _normalize_patent(item: dict[str, Any]) -> dict[str, Any] | None:
    application_number = _first_value(item.get("applicationNumber"))
    if not application_number:
        return None

    return {
        "application_number": application_number,
        "invention_title": _first_value(item.get("inventionTitle")),
        "applicant_name": _first_value(item.get("applicantName")),
        "ipc_number": _first_value(item.get("ipcNumber")),
        "register_status": _first_value(item.get("registerStatus")),
        "register_number": _first_value(item.get("registerNumber")),
        "register_date": _first_value(item.get("registerDate")),
        "application_date": _first_value(item.get("applicationDate")),
        "open_number": _first_value(item.get("openNumber")),
        "open_date": _first_value(item.get("openDate")),
        "publication_number": _first_value(item.get("publicationNumber")),
        "publication_date": _first_value(item.get("publicationDate")),
        "abstract": _first_value(item.get("astrtCont")),
        "drawing_url": _first_value(item.get("drawing")),
        "big_drawing_url": _first_value(item.get("bigDrawing")),
        "raw_search_json": item,
    }


@dataclass(frozen=True)
class KiprisConfig:
    service_key: str
    search_url: str
    detail_url: str
    pdf_url: str
    interval: float = 1.2
    timeout: int = 60
    max_retries: int = 4
    retry_backoff: float = 2.0


class KiprisClient:
    def __init__(self, config: KiprisConfig) -> None:
        self.config = config
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": "KIPRIS-Public-Platform/1.0",
                "Accept": "application/xml,text/xml,*/*",
            }
        )
        self._last_request_at = 0.0

    def _wait_rate_limit(self) -> None:
        elapsed = time.monotonic() - self._last_request_at
        wait = self.config.interval - elapsed
        if wait > 0:
            time.sleep(wait)

    def _retry_delay(self, attempt: int) -> float:
        base = max(self.config.retry_backoff, 0.5)
        return min(base * (2 ** max(attempt - 1, 0)) + random.uniform(0, 0.5), 20.0)

    def _service_limit_delay(self, attempt: int) -> float:
        return min(30.0 * (2 ** max(attempt - 1, 0)) + random.uniform(0, 2.0), 120.0)

    def _safe_response_preview(self, text: str, limit: int = 240) -> str:
        preview = " ".join(str(text or "").split())
        if self.config.service_key:
            preview = preview.replace(self.config.service_key, "***")
        if len(preview) > limit:
            preview = preview[:limit] + "..."
        return preview or "(빈 응답)"

    def _non_xml_error(self, response: requests.Response, text: str) -> KiprisError:
        content_type = response.headers.get("content-type", "unknown")
        preview = self._safe_response_preview(text)
        return KiprisError(
            "KIPRIS 비정상 응답 | "
            f"HTTP {response.status_code} | "
            f"content-type={content_type} | "
            f"응답={preview}"
        )

    def _get_xml(self, url: str, params: dict[str, Any]) -> tuple[ET.Element, str]:
        query = {**params, "ServiceKey": self.config.service_key}
        last_error: Exception | None = None
        max_attempts = max(self.config.max_retries, 1)

        for attempt in range(1, max_attempts + 1):
            _wait_shared_api_rate_limit(self.config.interval)
            try:
                response = self.session.get(
                    url,
                    params=query,
                    timeout=self.config.timeout,
                )
                self._last_request_at = time.monotonic()

                if response.status_code in {408, 425, 429, 500, 502, 503, 504}:
                    raise requests.HTTPError(
                        f"temporary HTTP {response.status_code}",
                        response=response,
                    )
                response.raise_for_status()

                text = response.text.strip()
                if not text:
                    raise self._non_xml_error(response, text)

                try:
                    root = ET.fromstring(text)
                except ET.ParseError as exc:
                    raise self._non_xml_error(response, text) from exc

                result_code = _find_text(root, "resultCode")
                result_message = _find_text(root, "resultMsg")
                if result_code and result_code not in {"00", "0"}:
                    message = (
                        f"KIPRIS 오류 {result_code}: "
                        f"{result_message or '알 수 없는 오류'}"
                    )
                    if result_code == "22":
                        raise KiprisRateLimitError(message)
                    raise KiprisError(message)

                return root, text
            except KiprisRateLimitError as exc:
                last_error = exc
                if attempt >= max_attempts:
                    break
                time.sleep(self._service_limit_delay(attempt))
            except (requests.RequestException, KiprisError) as exc:
                last_error = exc
                if attempt >= max_attempts:
                    break
                time.sleep(self._retry_delay(attempt))

        raise KiprisError(
            f"KIPRIS 요청 실패(재시도 {max_attempts}회): "
            f"{last_error}"
        ) from last_error

    def search(
        self,
        *,
        search_field: str,
        query_text: str,
        max_results: int,
        date_filter_type: str = "none",
        date_start_ym: str = "",
        date_end_ym: str = "",
    ) -> list[dict[str, Any]]:
        allowed = {
            "word",
            "inventionTitle",
            "applicant",
            "ipcNumber",
            "applicationNumber",
            "publicationNumber",
            "registerNumber",
        }
        if search_field not in allowed:
            raise KiprisError(f"지원하지 않는 검색항목: {search_field}")

        if date_filter_type not in {"none", "application", "registration"}:
            raise KiprisError(f"지원하지 않는 기간 기준: {date_filter_type}")

        rows = min(max(max_results, 1), 100)

        if date_filter_type == "none":
            params: dict[str, Any] = {
                search_field: query_text,
                "pageNo": 1,
                "numOfRows": 100,
                "sortSpec": "PD",
                "descSort": "true",
            }
            root, _ = self._get_xml(self.config.search_url, params)
            items = _find_items(root)

            normalized: list[dict[str, Any]] = []
            seen: set[str] = set()

            for item in items:
                patent = _normalize_patent(item)
                if patent is None:
                    continue
                if not _matches_exact_search(patent, search_field, query_text):
                    continue
                application_number = str(patent["application_number"])
                if application_number in seen:
                    continue
                seen.add(application_number)
                normalized.append(patent)

                if len(normalized) >= rows:
                    break

            return normalized

        if (
            len(date_start_ym) != 6
            or len(date_end_ym) != 6
            or not date_start_ym.isdigit()
            or not date_end_ym.isdigit()
            or date_start_ym > date_end_ym
        ):
            raise KiprisError("검색 기간의 시작·종료 연월이 올바르지 않습니다.")

        target_date_key = (
            "application_date"
            if date_filter_type == "application"
            else "register_date"
        )
        sort_spec = "AD" if date_filter_type == "application" else "GD"
        page_size = 100
        max_pages = 50
        normalized = []
        seen: set[str] = set()

        for page_no in range(1, max_pages + 1):
            params = {
                search_field: query_text,
                "pageNo": page_no,
                "numOfRows": page_size,
                "sortSpec": sort_spec,
                "descSort": "true",
            }
            root, _ = self._get_xml(self.config.search_url, params)
            items = _find_items(root)

            if not items:
                break

            page_has_date = False
            page_has_older_date = False

            for item in items:
                patent = _normalize_patent(item)
                if patent is None:
                    continue
                if not _matches_exact_search(patent, search_field, query_text):
                    continue

                application_number = str(patent["application_number"])
                if application_number in seen:
                    continue
                seen.add(application_number)

                year_month = _year_month(str(patent.get(target_date_key) or ""))
                if not year_month:
                    continue

                page_has_date = True

                if year_month < date_start_ym:
                    page_has_older_date = True
                    continue

                if year_month > date_end_ym:
                    continue

                normalized.append(patent)
                if len(normalized) >= rows:
                    return normalized

            if len(items) < page_size:
                break

            if page_has_date and page_has_older_date:
                break

        return normalized

    def get_detail_xml(self, application_number: str) -> str:
        _, xml_text = self._get_xml(
            self.config.detail_url,
            {"applicationNumber": application_number},
        )
        return xml_text

    def get_pdf_info(self, application_number: str) -> tuple[str, str] | None:
        root, _ = self._get_xml(
            self.config.pdf_url,
            {"applicationNumber": application_number},
        )
        for item in _find_items(root):
            path = _first_value(item.get("path"))
            name = _first_value(item.get("docName"))
            if path:
                return name or f"{application_number}.pdf", path
        return None

    def download_pdf(self, url: str, max_bytes: int) -> tuple[bytes, str]:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            raise KiprisError("PDF 주소 형식이 올바르지 않습니다.")

        last_error: Exception | None = None
        max_attempts = max(self.config.max_retries, 1)
        for attempt in range(1, max_attempts + 1):
            self._wait_rate_limit()
            try:
                response = self.session.get(
                    url,
                    timeout=self.config.timeout,
                    stream=True,
                )
                self._last_request_at = time.monotonic()
                if response.status_code in {408, 425, 429, 500, 502, 503, 504}:
                    raise requests.HTTPError(
                        f"temporary HTTP {response.status_code}",
                        response=response,
                    )
                response.raise_for_status()

                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_content(chunk_size=1024 * 128):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > max_bytes:
                        raise KiprisError("PDF가 허용된 최대 크기를 초과했습니다.")
                    chunks.append(chunk)

                data = b"".join(chunks)
                if not data.startswith(b"%PDF"):
                    raise KiprisError("다운로드 결과가 PDF 파일이 아닙니다.")

                return data, response.headers.get(
                    "content-type",
                    "application/pdf",
                )
            except (requests.RequestException, KiprisError) as exc:
                last_error = exc
                if attempt >= max_attempts:
                    break
                time.sleep(self._retry_delay(attempt))

        raise KiprisError(
            f"PDF 다운로드 실패(재시도 {max_attempts}회): "
            f"{last_error}"
        ) from last_error