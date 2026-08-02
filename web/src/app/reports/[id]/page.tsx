"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import {
  findStoredJob,
  getOutputFields,
  OutputField,
  StoredJob,
} from "@/lib/job-storage";
import {
  formatPatentDate,
  jobStatusLabel,
  searchFieldLabel,
} from "@/lib/patent-display";

type PatentResult = {
  display_order: number;
  id: string;
  application_number: string;
  invention_title: string | null;
  applicant_name: string | null;
  ipc_number: string | null;
  application_date: string | null;
  open_number: string | null;
  open_date: string | null;
  publication_number: string | null;
  publication_date: string | null;
  register_number: string | null;
  register_date: string | null;
  register_status: string | null;
  abstract: string | null;
  pdf_storage_path: string | null;
};

type JobReport = {
  id: string;
  query_text: string;
  search_field: string;
  max_results: number;
  download_pdf: boolean;
  status: string;
  progress_current: number;
  progress_total: number;
  result_count: number;
  report_title: string | null;
  review_purpose: string | null;
  output_fields: OutputField[] | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  results?: PatentResult[];
};

type Column = {
  key: string;
  label: string;
  field?: OutputField;
  value: (patent: PatentResult, index: number) => string;
  className?: string;
};

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function safeFilename(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "KIPRIS_특허_검토_결과";
}

export default function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [job, setJob] = useState<JobReport | null>(null);
  const [storedJob, setStoredJob] = useState<StoredJob | undefined>();
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("결과 장표를 불러오는 중...");

  useEffect(() => {
    const saved = findStoredJob(id);
    const queryToken = new URLSearchParams(window.location.search).get("token");
    setStoredJob(saved);
    setToken(queryToken || saved?.token || "");
  }, [id]);

  useEffect(() => {
    if (!token) {
      setMessage(
        "이 작업의 확인용 토큰이 없습니다. 작업을 등록했던 브라우저에서 다시 확인하세요.",
      );
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function loadReport() {
      try {
        const response = await fetch(
          `/api/jobs/${encodeURIComponent(
            id,
          )}?token=${encodeURIComponent(token)}&includeResults=1`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          throw new Error("결과 장표를 불러오지 못했습니다.");
        }

        const data = (await response.json()) as JobReport;
        if (!cancelled) {
          setJob(data);
          setMessage("");
          if (["completed", "failed", "cancelled"].includes(data.status)) {
            if (timer) clearInterval(timer);
          }
        }
      } catch (caught) {
        if (!cancelled) {
          setMessage(
            caught instanceof Error
              ? caught.message
              : "결과 장표를 불러오지 못했습니다.",
          );
        }
      }
    }

    loadReport();
    timer = setInterval(loadReport, 5000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [id, token]);

  const selectedFields = useMemo(
    () =>
      job?.output_fields && job.output_fields.length > 0
        ? job.output_fields
        : getOutputFields(storedJob),
    [job?.output_fields, storedJob],
  );

  const columns = useMemo<Column[]>(() => {
    const all: Column[] = [
      {
        key: "no",
        label: "No.",
        value: (patent, index) => String(patent.display_order || index + 1),
      },
      {
        key: "title",
        label: "발명의 명칭",
        value: (patent) => patent.invention_title || "제목 없음",
        className: "title-cell",
      },
      {
        key: "applicationNumber",
        label: "출원번호 / 공개번호",
        field: "applicationNumber",
        value: (patent) =>
          [patent.application_number, patent.publication_number]
            .filter(Boolean)
            .join(" / ") || "-",
      },
      {
        key: "applicant",
        label: "출원인",
        field: "applicant",
        value: (patent) => patent.applicant_name || "-",
      },
      {
        key: "ipc",
        label: "IPC",
        field: "ipc",
        value: (patent) => patent.ipc_number || "-",
      },
      {
        key: "dates",
        label: "출원일 / 공개일 / 등록일",
        field: "dates",
        value: (patent) =>
          [
            formatPatentDate(patent.application_date),
            formatPatentDate(patent.publication_date || patent.open_date),
            formatPatentDate(patent.register_date),
          ].join(" / "),
      },
      {
        key: "status",
        label: "권리 상태 / 등록번호",
        field: "status",
        value: (patent) =>
          [patent.register_status, patent.register_number]
            .filter(Boolean)
            .join(" / ") || "-",
      },
      {
        key: "abstract",
        label: "초록",
        field: "abstract",
        value: (patent) => patent.abstract || "-",
        className: "abstract-cell",
      },
      {
        key: "pdf",
        label: "PDF",
        field: "pdf",
        value: (patent) => (patent.pdf_storage_path ? "저장됨" : "없음"),
      },
    ];

    return all.filter(
      (column) => !column.field || selectedFields.includes(column.field),
    );
  }, [selectedFields]);

  if (!job) return <p className="notice">{message}</p>;

  const results = job.results ?? [];
  const title =
    job.report_title || storedJob?.reportTitle || "특허 검색·검토 결과";
  const applicantCount = new Set(
    results.map((item) => item.applicant_name).filter(Boolean),
  ).size;
  const pdfCount = results.filter((item) => item.pdf_storage_path).length;
  const detailUrl = `/jobs/${encodeURIComponent(job.id)}?token=${encodeURIComponent(
    token,
  )}`;

  function pdfViewUrl(patentId: string): string {
    return `/api/jobs/${encodeURIComponent(
      job.id,
    )}/pdf/${encodeURIComponent(patentId)}?token=${encodeURIComponent(token)}`;
  }

  function downloadCsv() {
    const header = columns.map((column) => csvCell(column.label)).join(",");
    const rows = results.map((patent, index) =>
      columns
        .map((column) => csvCell(column.value(patent, index)))
        .join(","),
    );
    const content = `\uFEFF${[header, ...rows].join("\r\n")}`;
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilename(title)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="report-page">
      <div className="report-toolbar no-print">
        <Link className="button secondary" href={detailUrl}>
          요청 검토로 돌아가기
        </Link>
        <div className="actions">
          <button className="button secondary" type="button" onClick={downloadCsv}>
            CSV 내려받기
          </button>
          <button type="button" onClick={() => window.print()}>
            인쇄·PDF 저장
          </button>
        </div>
      </div>

      <article className="report-sheet">
        <header className="report-title">
          <div>
            <p className="eyebrow">KIPRIS PATENT REVIEW REPORT</p>
            <h1>{title}</h1>
            <p>{job.review_purpose || storedJob?.reviewPurpose || "공개 특허 검색·수집 결과 검토"}</p>
          </div>
          <div className="report-status-box">
            <span>작업 상태</span>
            <strong>{jobStatusLabel(job.status)}</strong>
            <small>{new Date(job.created_at).toLocaleDateString("ko-KR")}</small>
          </div>
        </header>

        <section className="report-summary-grid">
          <div>
            <span>검색 조건</span>
            <strong>{searchFieldLabel(job.search_field)}</strong>
            <p>{job.query_text}</p>
          </div>
          <div>
            <span>저장 특허</span>
            <strong>{job.result_count}건</strong>
            <p>요청 한도 {job.max_results}건</p>
          </div>
          <div>
            <span>출원인</span>
            <strong>{applicantCount}개</strong>
            <p>결과 내 고유 출원인</p>
          </div>
          <div>
            <span>PDF 저장</span>
            <strong>{pdfCount}건</strong>
            <p>{job.download_pdf ? "PDF 요청 포함" : "PDF 요청 제외"}</p>
          </div>
        </section>

        <section className="report-criteria">
          <h2>요청 입력값</h2>
          <dl>
            <div>
              <dt>결과표 제목</dt>
              <dd>{title}</dd>
            </div>
            <div>
              <dt>검토 목적</dt>
              <dd>{job.review_purpose || storedJob?.reviewPurpose || "미입력"}</dd>
            </div>
            <div>
              <dt>검색 항목</dt>
              <dd>{searchFieldLabel(job.search_field)}</dd>
            </div>
            <div>
              <dt>검색어</dt>
              <dd>{job.query_text}</dd>
            </div>
            <div>
              <dt>최대 수집</dt>
              <dd>{job.max_results}건</dd>
            </div>
            <div>
              <dt>PDF</dt>
              <dd>{job.download_pdf ? "수집·저장" : "미수집"}</dd>
            </div>
          </dl>
        </section>

        <section className="report-results">
          <div className="section-heading horizontal">
            <div>
              <h2>특허 결과 목록</h2>
              <p>입력 단계에서 선택한 출력 항목에 맞춰 정리한 결과입니다.</p>
            </div>
            <span className="result-count">총 {results.length}건</span>
          </div>

          {selectedFields.includes("pdf") && pdfCount > 0 && (
            <p className="notice subtle no-print">
              PDF가 저장된 특허는 표의 <strong>PDF 보기</strong>를 누르면 새 탭에서 확인할 수 있습니다.
            </p>
          )}

          {job.error_message && (
            <p className={job.status === "completed" ? "warning" : "error"}>
              {job.error_message}
            </p>
          )}

          {results.length === 0 ? (
            <p className="notice subtle">
              아직 결과가 없습니다. 작업이 수집 중이면 잠시 후 자동으로 갱신됩니다.
            </p>
          ) : (
            <div className="table-scroll report-table-wrap">
              <table className="data-table report-table">
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th key={column.key}>{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map((patent, index) => (
                    <tr key={patent.id}>
                      {columns.map((column) => (
                        <td key={column.key} className={column.className}>
                          {column.key === "pdf" && patent.pdf_storage_path ? (
                            <a
                              className="button secondary no-print"
                              href={pdfViewUrl(patent.id)}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                display: "inline-flex",
                                padding: "6px 10px",
                                whiteSpace: "nowrap",
                                fontSize: "12px",
                              }}
                              aria-label={`${patent.invention_title || patent.application_number} PDF 보기`}
                            >
                              PDF 보기
                            </a>
                          ) : (
                            column.value(patent, index)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="report-footer">
          <span>작업 ID: {job.id}</span>
          <span>
            생성: {new Date(job.completed_at || job.created_at).toLocaleString("ko-KR")}
          </span>
        </footer>
      </article>
    </section>
  );
}
