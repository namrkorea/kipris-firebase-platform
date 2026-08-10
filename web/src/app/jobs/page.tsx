"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { readStoredJobs, removeStoredJob } from "@/lib/job-storage";
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
  dispatch_state: string | null;
  dispatch_message: string | null;
  dispatch_attempted_at: string | null;
  created_at: string;
};

type JobRow = JobStatus & {
  token?: string;
};

function queuedMinutes(createdAt: string): number {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((Date.now() - created) / 60000));
}

export default function JobsPage() {
  const [rows, setRows] = useState<JobRow[]>([]);
  const [message, setMessage] = useState("데이터베이스 작업 목록을 불러오는 중...");
  const [dispatching, setDispatching] = useState<Record<string, boolean>>({});
  const attemptedRef = useRef<Set<string>>(new Set());

  async function requestWorker(row: JobRow, manual = false) {
    if (!row.token || row.status !== "queued") return;
    if (!manual && attemptedRef.current.has(row.id)) return;

    attemptedRef.current.add(row.id);
    setDispatching((current) => ({ ...current, [row.id]: true }));

    try {
      await fetch(
        `/api/public-jobs/${encodeURIComponent(row.id)}/dispatch?token=${encodeURIComponent(row.token)}`,
        { method: "POST", cache: "no-store" },
      );
    } catch {
      // 상태는 다음 목록 갱신 때 서버 기록을 기준으로 표시합니다.
    } finally {
      setDispatching((current) => ({ ...current, [row.id]: false }));
      window.setTimeout(load, 700);
    }
  }

  async function load() {
    try {
      const response = await fetch("/api/public-jobs", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("작업 목록을 불러오지 못했습니다.");
      }

      const data = (await response.json()) as { jobs?: JobStatus[] };
      const localTokens = new Map(
        readStoredJobs().map((item) => [item.id, item.token]),
      );
      const next = (data.jobs ?? []).map((job) => ({
        ...job,
        token: localTokens.get(job.id),
      }));

      setRows(next);
      setMessage(next.length === 0 ? "데이터베이스에 저장된 작업이 없습니다." : "");

      for (const row of next) {
        if (
          row.status === "queued" &&
          row.token &&
          !row.dispatch_state &&
          !attemptedRef.current.has(row.id)
        ) {
          void requestWorker(row);
        }
      }
    } catch (caught) {
      setMessage(
        caught instanceof Error ? caught.message : "작업 목록을 불러오지 못했습니다.",
      );
    }
  }

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 10000);
    return () => window.clearInterval(timer);
  }, []);

  async function removeOne(row: JobRow) {
    if (!row.token) {
      window.alert("이 작업을 삭제할 수 있는 확인용 토큰이 이 브라우저에 없습니다.");
      return;
    }

    const title = row.report_title || "특허 검색·검토 결과";
    const confirmed = window.confirm(
      `“${title}”을(를) 작업 목록과 데이터베이스에서 삭제할까요?\n\n` +
        "작업 기록과 작업-결과 연결정보는 삭제됩니다. 특허 원문 데이터와 Firebase Storage의 PDF 원본은 유지됩니다.",
    );
    if (!confirmed) return;

    try {
      const response = await fetch(
        `/api/public-jobs/${encodeURIComponent(row.id)}?token=${encodeURIComponent(row.token)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "작업을 삭제하지 못했습니다.");
      }

      removeStoredJob(row.id);
      setRows((current) => current.filter((item) => item.id !== row.id));
    } catch (caught) {
      window.alert(
        caught instanceof Error ? caught.message : "작업을 삭제하지 못했습니다.",
      );
    }
  }

  return (
    <section>
      <div className="page-title-row">
        <div>
          <p className="eyebrow">REQUEST & OUTPUT</p>
          <h1>요청·결과 목록</h1>
          <p className="page-description">
            데이터베이스에 저장된 검색 요청과 작업 진행 상태를 누구나 확인할 수 있습니다.
          </p>
        </div>
        <div className="page-title-actions">
          <Link className="button" href="/request">
            새 수집 요청
          </Link>
        </div>
      </div>

      <p className="notice">
        이 목록은 Firebase 데이터베이스의 작업 기록을 공용으로 표시합니다. 누구나 작업명,
        검색어, 진행상태와 결과 건수를 보고 결과 장표와 저장된 특허 PDF를 열 수 있습니다.
        요청·진행 검토와 삭제는 해당 작업의 확인용 토큰을 가진 브라우저에서만 가능합니다.
        대기 작업은 등록한 브라우저에서 GitHub Worker 즉시 실행을 자동 재요청하며, 실패 원인을 화면에 표시합니다.
      </p>

      {message && <p className="notice">{message}</p>}

      <div className="job-grid">
        {rows.map((job) => {
          const percent =
            job.progress_total > 0
              ? Math.min(
                  100,
                  Math.round((job.progress_current / job.progress_total) * 100),
                )
              : 0;
          const detailUrl = job.token
            ? `/jobs/${encodeURIComponent(job.id)}?token=${encodeURIComponent(job.token)}`
            : "";
          const reportToken = job.token || "public";
          const reportUrl = `/reports/${encodeURIComponent(job.id)}?token=${encodeURIComponent(reportToken)}`;
          const waitMinutes = job.status === "queued" ? queuedMinutes(job.created_at) : 0;
          const showDispatchWarning =
            job.status === "queued" &&
            (job.dispatch_state === "missing_token" || job.dispatch_state === "failed");

          return (
            <article key={job.id} className="card job-card">
              <div className="job-card-header">
                <div>
                  <span className={`status status-${job.status}`}>
                    {jobStatusLabel(job.status)}
                  </span>
                  <h2>{job.report_title || "특허 검색·검토 결과"}</h2>
                  <p className="job-query">
                    {searchFieldLabel(job.search_field)} · “{job.query_text}”
                  </p>
                </div>
                <time>{new Date(job.created_at).toLocaleString("ko-KR")}</time>
              </div>

              {job.review_purpose && (
                <p className="job-purpose">검토 목적: {job.review_purpose}</p>
              )}

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

              {job.status === "queued" && (
                <p className={showDispatchWarning ? "error" : "notice"}>
                  {job.dispatch_state === "sent"
                    ? `GitHub Worker 즉시 실행 요청 완료 · 현재 대기 ${waitMinutes}분`
                    : job.dispatch_message
                      ? `${job.dispatch_message} · 현재 대기 ${waitMinutes}분`
                      : `GitHub Worker 즉시 실행 확인 중 · 현재 대기 ${waitMinutes}분`}
                </p>
              )}

              {job.error_message && (
                <p className={job.status === "completed" ? "warning" : "error"}>
                  {job.error_message}
                </p>
              )}

              <div className="job-actions">
                {job.token && (
                  <>
                    <button
                      className="button danger-outline"
                      type="button"
                      onClick={() => removeOne(job)}
                    >
                      목록·DB에서 삭제
                    </button>
                    <Link className="button secondary" href={detailUrl}>
                      요청·진행 검토
                    </Link>
                    {job.status === "queued" && showDispatchWarning && (
                      <button
                        className="button secondary"
                        type="button"
                        disabled={Boolean(dispatching[job.id])}
                        onClick={() => requestWorker(job, true)}
                      >
                        {dispatching[job.id] ? "Worker 호출 중..." : "Worker 즉시 재호출"}
                      </button>
                    )}
                  </>
                )}
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
