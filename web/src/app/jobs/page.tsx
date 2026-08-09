"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  clearStoredJobs,
  readStoredJobs,
  removeStoredJob,
  StoredJob,
} from "@/lib/job-storage";
import { jobStatusLabel, searchFieldLabel } from "@/lib/patent-display";

type JobStatus = {
  id: string;
  query_text: string;
  search_field: string;
  status: string;
  progress_current: number;
  progress_total: number;
  result_count: number;
  report_title: string | null;
  review_purpose: string | null;
  output_fields: string[] | null;
  error_message: string | null;
  created_at: string;
};

type JobRow = StoredJob & {
  statusData?: JobStatus;
  loadError?: string;
};

const EMPTY_MESSAGE =
  "이 브라우저에서 등록한 작업이 없습니다. 수집 요청 후 이곳에서 확인할 수 있습니다.";

export default function JobsPage() {
  const [rows, setRows] = useState<JobRow[]>([]);
  const [message, setMessage] = useState("작업 기록을 불러오는 중...");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const stored = readStoredJobs();
      if (stored.length === 0) {
        setRows([]);
        setMessage(EMPTY_MESSAGE);
        return;
      }

      const loaded = await Promise.all(
        stored.map(async (item): Promise<JobRow> => {
          try {
            const response = await fetch(
              `/api/jobs/${encodeURIComponent(
                item.id,
              )}?token=${encodeURIComponent(item.token)}`,
              { cache: "no-store" },
            );

            if (!response.ok) {
              return { ...item, loadError: "상태를 확인할 수 없습니다." };
            }

            const statusData = (await response.json()) as JobStatus;
            return { ...item, statusData };
          } catch {
            return { ...item, loadError: "상태를 확인할 수 없습니다." };
          }
        }),
      );

      if (!cancelled) {
        const currentIds = new Set(readStoredJobs().map((item) => item.id));
        const visibleRows = loaded.filter((item) => currentIds.has(item.id));
        setRows(visibleRows);
        setMessage(visibleRows.length === 0 ? EMPTY_MESSAGE : "");
      }
    }

    load();
    const timer = window.setInterval(load, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  function removeOne(row: JobRow) {
    const title =
      row.statusData?.report_title ||
      row.reportTitle ||
      "특허 검색·검토 결과";

    const confirmed = window.confirm(
      `“${title}”을(를) 요청·결과 목록에서 삭제할까요?\n\n` +
        "현재 브라우저의 목록에서만 제거되며, Firebase에 저장된 특허와 PDF 원본은 삭제되지 않습니다.",
    );

    if (!confirmed) return;

    removeStoredJob(row.id);
    const next = rows.filter((item) => item.id !== row.id);
    setRows(next);
    if (next.length === 0) setMessage(EMPTY_MESSAGE);
  }

  function removeAll() {
    if (rows.length === 0) return;

    const confirmed = window.confirm(
      `현재 표시된 요청·결과 ${rows.length}건을 모두 목록에서 삭제할까요?\n\n` +
        "현재 브라우저의 목록만 비워지며, Firebase에 저장된 특허와 PDF 원본은 삭제되지 않습니다.",
    );

    if (!confirmed) return;

    clearStoredJobs();
    setRows([]);
    setMessage(EMPTY_MESSAGE);
  }

  return (
    <section>
      <div className="page-title-row">
        <div>
          <p className="eyebrow">REQUEST & OUTPUT</p>
          <h1>요청·결과 목록</h1>
          <p className="page-description">
            입력한 검색 조건, 작업 진행 상태, 정리된 결과 장표를 확인합니다.
          </p>
        </div>
        <div className="page-title-actions">
          {rows.length > 0 && (
            <button className="button danger-outline" type="button" onClick={removeAll}>
              목록 전체 비우기
            </button>
          )}
          <Link className="button" href="/request">
            새 수집 요청
          </Link>
        </div>
      </div>

      <p className="notice">
        작업 확인용 토큰과 출력 선택값은 현재 브라우저에만 저장됩니다. 목록 삭제는
        이 브라우저에서만 적용되며, Firebase의 특허·PDF 원본은 그대로 유지됩니다.
      </p>

      {message && <p className="notice">{message}</p>}

      <div className="job-grid">
        {rows.map((row) => {
          const job = row.statusData;
          const percent =
            job && job.progress_total > 0
              ? Math.min(
                  100,
                  Math.round(
                    (job.progress_current / job.progress_total) * 100,
                  ),
                )
              : 0;
          const detailUrl = `/jobs/${encodeURIComponent(
            row.id,
          )}?token=${encodeURIComponent(row.token)}`;
          const reportUrl = `/reports/${encodeURIComponent(
            row.id,
          )}?token=${encodeURIComponent(row.token)}`;

          return (
            <article key={row.id} className="card job-card">
              <div className="job-card-header">
                <div>
                  <span className={`status status-${job?.status ?? "loading"}`}>
                    {job ? jobStatusLabel(job.status) : "확인 중"}
                  </span>
                  <h2>
                    {job?.report_title ||
                      row.reportTitle ||
                      "특허 검색·검토 결과"}
                  </h2>
                  <p className="job-query">
                    {searchFieldLabel(job?.search_field ?? "word")} · “
                    {job?.query_text ?? row.queryText}”
                  </p>
                </div>
                <time>
                  {new Date(job?.created_at ?? row.createdAt).toLocaleString(
                    "ko-KR",
                  )}
                </time>
              </div>

              {(job?.review_purpose || row.reviewPurpose) && (
                <p className="job-purpose">
                  검토 목적: {job?.review_purpose || row.reviewPurpose}
                </p>
              )}

              {job && (
                <>
                  <div className="job-metrics">
                    <span>
                      <strong>{job.progress_current}</strong>
                      진행
                    </span>
                    <span>
                      <strong>{job.progress_total || "-"}</strong>
                      대상
                    </span>
                    <span>
                      <strong>{job.result_count}</strong>
                      저장 결과
                    </span>
                  </div>
                  <div className="progress" aria-label={`진행률 ${percent}%`}>
                    <div style={{ width: `${percent}%` }} />
                  </div>
                </>
              )}

              {row.loadError && <p className="error">{row.loadError}</p>}
              {job?.error_message && (
                <p className={job.status === "completed" ? "warning" : "error"}>
                  {job.error_message}
                </p>
              )}

              <div className="job-actions">
                <button
                  className="button danger-outline"
                  type="button"
                  onClick={() => removeOne(row)}
                >
                  목록에서 삭제
                </button>
                <Link className="button secondary" href={detailUrl}>
                  요청·진행 검토
                </Link>
                <Link className="button" href={reportUrl}>
                  결과 장표 보기
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
