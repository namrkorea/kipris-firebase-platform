"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  exportStoredJobs,
  importStoredJobs,
  readStoredJobs,
  removeStoredJob,
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

type JobRow = JobStatus & {
  token?: string;
};

export default function JobsPage() {
  const [rows, setRows] = useState<JobRow[]>([]);
  const [message, setMessage] = useState("데이터베이스 작업 목록을 불러오는 중...");

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

  async function backupAccessKey() {
    if (readStoredJobs().length === 0) {
      window.alert("백업할 작업 접근정보가 없습니다.");
      return;
    }

    const accessKey = exportStoredJobs();
    try {
      await navigator.clipboard.writeText(accessKey);
      window.alert(
        "작업 접근키를 클립보드에 복사했습니다. 다른 PC에서 복원하면 본인이 등록한 작업의 상세 결과를 다시 열거나 삭제할 수 있습니다.\n\n비밀 토큰이 포함되어 있으므로 타인에게 공유하지 마세요.",
      );
    } catch {
      window.prompt("아래 작업 접근키를 전체 복사해 안전하게 보관하세요.", accessKey);
    }
  }

  function restoreAccessKey() {
    const raw = window.prompt(
      "다른 PC에서 백업한 작업 접근키를 붙여넣으세요.\n복원하면 본인이 등록한 작업의 상세 결과를 다시 열거나 삭제할 수 있습니다.",
    );
    if (!raw) return;

    try {
      const count = importStoredJobs(raw.trim());
      window.alert(`${count}건의 작업 접근정보를 복원했습니다.`);
      load();
    } catch (caught) {
      window.alert(
        caught instanceof Error ? caught.message : "작업 접근키를 복원하지 못했습니다.",
      );
    }
  }

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
          <button className="button secondary" type="button" onClick={restoreAccessKey}>
            접근키 복원
          </button>
          <button className="button secondary" type="button" onClick={backupAccessKey}>
            접근키 백업
          </button>
          <Link className="button" href="/request">
            새 수집 요청
          </Link>
        </div>
      </div>

      <p className="notice">
        이 목록은 Firebase 데이터베이스의 작업 기록을 공용으로 표시합니다. 누구나 작업명,
        검색어, 진행상태와 결과 건수를 볼 수 있습니다. 상세 결과 열람과 삭제는 해당 작업의
        확인용 토큰을 가진 브라우저에서만 가능합니다. 삭제 시 작업 기록과 결과 연결정보는
        데이터베이스에서 삭제되며 특허 원문과 PDF 원본은 유지됩니다.
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
          const reportUrl = job.token
            ? `/reports/${encodeURIComponent(job.id)}?token=${encodeURIComponent(job.token)}`
            : "";

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

              {job.error_message && (
                <p className={job.status === "completed" ? "warning" : "error"}>
                  {job.error_message}
                </p>
              )}

              <div className="job-actions">
                {job.token ? (
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
                    <Link className="button" href={reportUrl}>
                      결과 장표 보기
                    </Link>
                  </>
                ) : (
                  <span className="notice subtle">공개 목록 보기 전용</span>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
