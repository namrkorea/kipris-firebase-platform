"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { findStoredJob, StoredJob } from "@/lib/job-storage";
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
  publication_number: string | null;
  publication_date: string | null;
  register_status: string | null;
  pdf_storage_path: string | null;
};

type Job = {
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
  output_fields: string[] | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  results?: PatentResult[];
};

export default function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [job, setJob] = useState<Job | null>(null);
  const [storedJob, setStoredJob] = useState<StoredJob | undefined>();
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("작업 정보를 불러오는 중...");

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

    async function loadJob() {
      try {
        const response = await fetch(
          `/api/jobs/${encodeURIComponent(
            id,
          )}?token=${encodeURIComponent(token)}&includeResults=1`,
          { cache: "no-store" },
        );

        if (!response.ok) {
          throw new Error("작업을 찾을 수 없거나 확인용 토큰이 올바르지 않습니다.");
        }

        const data = (await response.json()) as Job;
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
              : "작업 정보를 불러오지 못했습니다.",
          );
        }
      }
    }

    loadJob();
    timer = setInterval(loadJob, 5000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [id, token]);

  const percent = useMemo(() => {
    if (!job || job.progress_total <= 0) return 0;
    return Math.min(
      100,
      Math.round((job.progress_current / job.progress_total) * 100),
    );
  }, [job]);

  if (!job) return <p className="notice">{message}</p>;

  const reportUrl = `/reports/${encodeURIComponent(
    job.id,
  )}?token=${encodeURIComponent(token)}`;

  return (
    <section>
      <div className="page-title-row">
        <div>
          <p className="eyebrow">REQUEST REVIEW</p>
          <h1>{job.report_title || storedJob?.reportTitle || "특허 검색·검토 결과"}</h1>
          <p className="page-description">
            등록한 입력값과 수집 진행 상태를 검토합니다.
          </p>
        </div>
        <Link className="button" href={reportUrl}>
          결과 장표 열기
        </Link>
      </div>

      <div className="detail-layout">
        <section className="card">
          <div className="review-header compact">
            <div>
              <h2>요청 입력값</h2>
              <p>수집 요청 시 최종 확인한 조건입니다.</p>
            </div>
            <span className={`status status-${job.status}`}>
              {jobStatusLabel(job.status)}
            </span>
          </div>
          <dl className="review-list compact-list">
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
              <dt>최대 수집 건수</dt>
              <dd>{job.max_results}건</dd>
            </div>
            <div>
              <dt>공개전문 PDF</dt>
              <dd>{job.download_pdf ? "수집·저장" : "수집하지 않음"}</dd>
            </div>
          </dl>
        </section>

        <section className="card progress-card">
          <h2>수집 진행</h2>
          <div className="progress-number">{percent}%</div>
          <div className="progress large">
            <div style={{ width: `${percent}%` }} />
          </div>
          <div className="job-metrics">
            <span>
              <strong>{job.progress_current}</strong>
              처리
            </span>
            <span>
              <strong>{job.progress_total || "-"}</strong>
              검색 결과
            </span>
            <span>
              <strong>{job.result_count}</strong>
              저장 완료
            </span>
          </div>
          {job.error_message && <p className="error">{job.error_message}</p>}
        </section>
      </div>

      <section className="card result-preview">
        <div className="section-heading horizontal">
          <div>
            <h2>수집 결과 미리보기</h2>
            <p>최대 10건을 표시합니다. 전체 결과는 결과 장표에서 확인합니다.</p>
          </div>
          <Link className="button secondary" href={reportUrl}>
            전체 결과 보기
          </Link>
        </div>

        {(job.results?.length ?? 0) === 0 ? (
          <p className="notice subtle">
            아직 저장된 결과가 없습니다. Worker가 처리 중이면 잠시 후 자동으로
            갱신됩니다.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>No.</th>
                  <th>발명의 명칭</th>
                  <th>출원번호</th>
                  <th>출원인</th>
                  <th>출원일</th>
                  <th>PDF</th>
                </tr>
              </thead>
              <tbody>
                {job.results?.slice(0, 10).map((patent, index) => (
                  <tr key={patent.id}>
                    <td>{patent.display_order || index + 1}</td>
                    <td className="title-cell">
                      {patent.invention_title || "제목 없음"}
                    </td>
                    <td>{patent.application_number}</td>
                    <td>{patent.applicant_name || "-"}</td>
                    <td>{formatPatentDate(patent.application_date)}</td>
                    <td>{patent.pdf_storage_path ? "저장" : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="timeline-row">
        <span>등록 {new Date(job.created_at).toLocaleString("ko-KR")}</span>
        {job.started_at && (
          <span>시작 {new Date(job.started_at).toLocaleString("ko-KR")}</span>
        )}
        {job.completed_at && (
          <span>완료 {new Date(job.completed_at).toLocaleString("ko-KR")}</span>
        )}
      </div>
    </section>
  );
}
