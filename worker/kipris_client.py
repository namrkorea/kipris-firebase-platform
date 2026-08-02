from __future__ import annotations

from dataclasses import dataclass
import json
import random
import time
from typing import Any
from urllib.parse import urlparse
import xml.etree.ElementTree as ET

import requests


class KiprisError(RuntimeError):
    pass


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


@dataclass(frozen=True)
class KiprisConfig:
    service_key: str
    search_url: str
    detail_url: str
    pdf_url: str
    interval: float = 0.6
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

    def _get_xml(self, url: str, params: dict[str, Any]) -> tuple[ET.Element, str]:
        query = {**params, "ServiceKey": self.config.service_key}
        last_error: Exception | None = None

        for attempt in range(1, max(self.config.max_retries, 1) + 1):
            self._wait_rate_limit()
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
                    raise KiprisError("KIPRIS가 빈 응답을 반환했습니다.")

                try:
                    root = ET.fromstring(text)
                except ET.ParseError as exc:
                    raise KiprisError("KIPRIS XML을 해석할 수 없습니다.") from exc

                result_code = _find_text(root, "resultCode")
                result_message = _find_text(root, "resultMsg")
                if result_code and result_code not in {"00", "0"}:
                    raise KiprisError(
                        f"KIPRIS 오류 {result_code}: "
                        f"{result_message or '알 수 없는 오류'}"
                    )

                return root, text
            except (requests.RequestException, KiprisError) as exc:
                last_error = exc
                if attempt >= max(self.config.max_retries, 1):
                    break
                time.sleep(self._retry_delay(attempt))

        raise KiprisError(
            f"KIPRIS 요청 실패(재시도 {max(self.config.max_retries, 1)}회): "
            f"{last_error}"
        ) from last_error

    def search(
        self,
        *,
        search_field: str,
        query_text: str,
        max_results: int,
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

        rows = min(max(max_results, 1), 100)
        params: dict[str, Any] = {
            search_field: query_text,
            "pageNo": 1,
            "numOfRows": rows,
            "sortSpec": "PD",
            "descSort": "true",
        }
        root, _ = self._get_xml(self.config.search_url, params)
        items = _find_items(root)

        normalized: list[dict[str, Any]] = []
        seen: set[str] = set()

        for item in items:
            application_number = _first_value(item.get("applicationNumber"))
            if not application_number or application_number in seen:
                continue
            seen.add(application_number)

            normalized.append(
                {
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
            )

            if len(normalized) >= rows:
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
        for attempt in range(1, max(self.config.max_retries, 1) + 1):
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
                if attempt >= max(self.config.max_retries, 1):
                    break
                time.sleep(self._retry_delay(attempt))

        raise KiprisError(
            f"PDF 다운로드 실패(재시도 {max(self.config.max_retries, 1)}회): "
            f"{last_error}"
        ) from last_error
