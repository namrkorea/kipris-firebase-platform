"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_OUTPUT_FIELDS,
  OutputField,
  saveStoredJob,
} from "@/lib/job-storage";
import { searchFieldLabel } from "@/lib/patent-display";

type SearchField =
  | "word"
  | "inventionTitle"
  | "applicant"
  | "ipcNumber"
  | "applicationNumber"
  | "publicationNumber"
  | "registerNumber";

type DateFilterType = "none" | "application" | "registration";
type Step = "input" | "review";

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from(
  { length: CURRENT_YEAR - 1949 },
  (_, index) => CURRENT_YEAR - index,
);
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) =>
  String(index + 1).padStart(2, "0"),
);

const OUTPUT_OPTIONS: Array<{
  value: OutputField;
  label: string;
  description: string;
}> = [
  { value: "applicationNumber", label: "출원·공개번호", description: "출원번호와 공개번호를 결과표에 표시" },
  { value: "applicant", label: "출원인", description: "출원인 명칭을 표시" },
  { value: "ipc", label: "IPC", description: "국제특허분류를 표시" },
  { value: "dates", label: "주요 일자", description: "출원일·공개일·등록일을 표시" },
  { value: "status", label: "권리 상태", description: "등록 상태와 등록번호를 표시" },
  { value: "abstract", label: "초록", description: "특허별 초록을 결과표에 표시" },
  { value: "pdf", label: "PDF 저장 여부", description: "공개전문 PDF 저장 여부를 표시" },
];

const rowStyle = {
  display: "grid",
  gridTemplateColumns: "135px 240px minmax(280px, 1fr) 86px 34px",
  gap: "8px",
  alignItems: "center",
  padding: "7px 0",
} as const;

const labelStyle = {
  margin: 0,
  fontWeight: 800,
  color: "#26364b",
} as const;

const andStyle = {
  minHeight: "46px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid #b9c5d4",
  borderRadius: "9px",
  background: "#fff",
  fontWeight: 700,
  color: "#394a61",
} as const;

function formatYearMonth(value: string): string {
  if (!/^\d{6}$/.test(value)) return value;
  return `${value.slice(0, 4)}.${value.slice(4, 6)}`;
}

export default function RequestPage() {
  const router = useRouter();
  const currentMonth = String(new Date().getMonth() + 1).padStart(2, "0");
  const [step, setStep] = useState<Step>("input");
  const [reportTitle, setReportTitle] = useState("특허 검색·검토 결과");
  const [reviewPurpose, setReviewPurpose] = useState("");
  const [queryText, setQueryText] = useState("");
  const [searchField, setSearchField] = useState<SearchField>("word");
  const [contentField, setContentField] = useState<SearchField>("inventionTitle");
  const [numberField, setNumberField] = useState<SearchField>("registerNumber");
  const [personField, setPersonField] = useState<SearchField>("applicant");
  const [dateFilterType, setDateFilterType] = useState<DateFilterType>("none");
  const [dateStartYear, setDateStartYear] = useState(String(CURRENT_YEAR - 5));
  const [dateStartMonth, setDateStartMonth] = useState("01");
  const [dateEndYear, setDateEndYear] = useState(String(CURRENT_YEAR));
  const [dateEndMonth, setDateEndMonth] = useState(currentMonth);
  const [maxResults, setMaxResults] = useState(30);
  const [downloadPdf, setDownloadPdf] = useState(true);
  const [outputFields, setOutputFields] = useState<OutputField[]>(DEFAULT_OUTPUT_FIELDS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const dateStartYm = `${dateStartYear}${dateStartMonth}`;
  const dateEndYm = `${dateEndYear}${dateEndMonth}`;
  const dateFilterLabel =
    dateFilterType === "application"
      ? "출원일"
      : dateFilterType === "registration"
        ? "등록일"
        : "기간 제한 없음";

  const reviewRows = useMemo(
    () => [
      ["결과표 제목", reportTitle.trim() || "특허 검색·검토 결과"],
      ["검토 목적", reviewPurpose.trim() || "미입력"],
      ["검색 항목", searchFieldLabel(searchField)],
      ["검색어", queryText.trim() || "미입력"],
      [
        "검색 기간",
        dateFilterType === "none"
          ? "기간 제한 없음"
          : `${dateFilterLabel} ${formatYearMonth(dateStartYm)} ~ ${formatYearMonth(dateEndYm)}`,
      ],
      ["최대 수집 건수", `${maxResults}건`],
      ["공개전문 PDF", downloadPdf ? "수집·저장" : "수집하지 않음"],
      [
        "결과표 표시 항목",
        OUTPUT_OPTIONS.filter((option) => outputFields.includes(option.value))
          .map((option) => option.label)
          .join(", ") || "기본 제목만",
      ],
    ],
    [
      reportTitle,
      reviewPurpose,
      searchField,
      queryText,
      dateFilterType,
      dateFilterLabel,
      dateStartYm,
      dateEndYm,
      maxResults,
      downloadPdf,
      outputFields,
    ],
  );

  function selectField(field: SearchField) {
    setSearchField(field);
    setQueryText("");
    setError("");
  }

  function rowValue(field: SearchField): string {
    return searchField === field ? queryText : "";
  }

  function setRowValue(field: SearchField, value: string) {
    setSearchField(field);
    setQueryText(value);
    setError("");
  }

  function validateInput(): boolean {
    setError("");
    if (queryText.trim().length < 2) {
      setError("검색어는 두 글자 이상 입력하세요.");
      return false;
    }
    if (reportTitle.trim().length > 100) {
      setError("결과표 제목은 100자 이하로 입력하세요.");
      return false;
    }
    if (reviewPurpose.trim().length > 500) {
      setError("검토 목적은 500자 이하로 입력하세요.");
      return false;
    }
    if (dateFilterType !== "none" && dateStartYm > dateEndYm) {
      setError("검색 기간의 시작 연월이 종료 연월보다 늦습니다.");
      return false;
    }
    return true;
  }

  function openReview(event: FormEvent) {
    event.preventDefault();
    if (validateInput()) setStep("review");
  }

  function toggleOutputField(field: OutputField) {
    setOutputFields((current) =>
      current.includes(field)
        ? current.filter((item) => item !== field)
        : [...current, field],
    );
  }

  async function submitJob() {
    if (!validateInput()) {
      setStep("input");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const query = queryText.trim();
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queryText: query,
          searchField,
          dateFilterType,
          dateStartYm: dateFilterType === "none" ? "" : dateStartYm,
          dateEndYm: dateFilterType === "none" ? "" : dateEndYm,
          maxResults,
          downloadPdf,
          reportTitle: reportTitle.trim() || "특허 검색·검토 결과",
          reviewPurpose: reviewPurpose.trim(),
          outputFields,
        }),
      });

      const result = (await response.json()) as {
        id?: string;
        token?: string;
        error?: string;
      };

      if (!response.ok || !result.id || !result.token) {
        throw new Error(result.error || "작업을 등록하지 못했습니다.");
      }

      saveStoredJob({
        id: result.id,
        token: result.token,
        queryText: query,
        createdAt: new Date().toISOString(),
        reportTitle: reportTitle.trim() || "특허 검색·검토 결과",
        reviewPurpose: reviewPurpose.trim(),
        outputFields,
      });

      router.push(
        `/jobs/${encodeURIComponent(result.id)}?token=${encodeURIComponent(result.token)}`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "작업을 등록하지 못했습니다.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <div className="page-title-row">
        <div>
          <p className="eyebrow">KIPRIS COLLECTION REQUEST</p>
          <h1>특허 수집·검토 요청</h1>
          <p className="page-description">
            검색 조건과 출력 항목을 입력한 뒤 검토 화면에서 최종 확인합니다.
          </p>
        </div>
        <div className="step-indicator" aria-label="입력 단계">
          <span className={step === "input" ? "active" : "done"}>1 입력</span>
          <span className={step === "review" ? "active" : ""}>2 검토·등록</span>
        </div>
      </div>

      {step === "input" ? (
        <form className="card request-form" onSubmit={openReview}>
          <div className="form-section">
            <div className="section-heading">
              <h2>1. 검토 기본정보</h2>
              <p>결과 장표의 제목과 검토 목적에 사용됩니다.</p>
            </div>
            <div className="form-grid two-columns">
              <div className="field-group">
                <label htmlFor="reportTitle">결과표 제목</label>
                <input
                  id="reportTitle"
                  value={reportTitle}
                  onChange={(event) => setReportTitle(event.target.value)}
                  maxLength={100}
                  placeholder="예: FLNG 핵심특허 검토 결과"
                />
              </div>
              <div className="field-group">
                <label htmlFor="reviewPurpose">검토 목적</label>
                <input
                  id="reviewPurpose"
                  value={reviewPurpose}
                  onChange={(event) => setReviewPurpose(event.target.value)}
                  maxLength={500}
                  placeholder="예: 경쟁사 기술동향 및 유사특허 검토"
                />
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="section-heading">
              <h2>2. 검색 조건</h2>
              <p>첨부한 KIPRIS 화면과 유사하게 검색 항목을 분야별로 배치했습니다.</p>
            </div>

            <div
              style={{
                border: "1px solid #d9e0ea",
                borderRadius: "14px",
                padding: "16px 18px",
                background: "#fbfcfe",
                overflowX: "auto",
              }}
            >
              <div style={{ minWidth: "900px" }}>
                <div style={rowStyle}>
                  <label style={labelStyle}>자유검색(전문)</label>
                  <div style={{ gridColumn: "2 / 3" }} />
                  <input
                    aria-label="자유검색"
                    value={rowValue("word")}
                    onFocus={() => searchField !== "word" && selectField("word")}
                    onChange={(event) => setRowValue("word", event.target.value)}
                    placeholder={'예) 자동차 엔진  (구문검색: "휴대폰케이스")'}
                  />
                  <div style={andStyle}>AND</div>
                  <span style={{ textAlign: "center", fontSize: "22px", color: "#6b7788" }}>＋</span>
                </div>

                <div style={rowStyle}>
                  <label style={labelStyle}>내용검색</label>
                  <select
                    value={contentField}
                    onChange={(event) => {
                      const field = event.target.value as SearchField;
                      setContentField(field);
                      selectField(field);
                    }}
                  >
                    <option value="inventionTitle">발명의명칭(TL)</option>
                  </select>
                  <input
                    aria-label="내용검색"
                    value={rowValue(contentField)}
                    onFocus={() => searchField !== contentField && selectField(contentField)}
                    onChange={(event) => setRowValue(contentField, event.target.value)}
                    placeholder={'예) 휴대폰 터치스크린, 전자*화폐, "휴대폰케이스"'}
                  />
                  <div style={andStyle}>AND</div>
                  <span style={{ textAlign: "center", fontSize: "22px", color: "#6b7788" }}>＋</span>
                </div>

                <div style={rowStyle}>
                  <label style={labelStyle}>번호정보</label>
                  <select
                    value={numberField}
                    onChange={(event) => {
                      const field = event.target.value as SearchField;
                      setNumberField(field);
                      selectField(field);
                    }}
                  >
                    <option value="applicationNumber">출원번호(AN)</option>
                    <option value="registerNumber">등록번호(GN)</option>
                    <option value="publicationNumber">공고번호(PN)</option>
                  </select>
                  <input
                    aria-label="번호정보"
                    value={rowValue(numberField)}
                    onFocus={() => searchField !== numberField && selectField(numberField)}
                    onChange={(event) => setRowValue(numberField, event.target.value)}
                    placeholder="예) 1020150123456"
                  />
                  <div style={andStyle}>AND</div>
                  <span style={{ textAlign: "center", fontSize: "22px", color: "#6b7788" }}>＋</span>
                </div>

                <div style={rowStyle}>
                  <label style={labelStyle}>분류정보</label>
                  <select value="ipcNumber" onChange={() => undefined}>
                    <option value="ipcNumber">IPC</option>
                  </select>
                  <input
                    aria-label="IPC"
                    value={rowValue("ipcNumber")}
                    onFocus={() => searchField !== "ipcNumber" && selectField("ipcNumber")}
                    onChange={(event) => setRowValue("ipcNumber", event.target.value)}
                    placeholder="예) G06Q + H04Q"
                  />
                  <div style={andStyle}>AND</div>
                  <span style={{ textAlign: "center", fontSize: "22px", color: "#6b7788" }}>＋</span>
                </div>

                <div style={rowStyle}>
                  <label style={labelStyle}>인명정보</label>
                  <select
                    value={personField}
                    onChange={(event) => {
                      const field = event.target.value as SearchField;
                      setPersonField(field);
                      selectField(field);
                    }}
                  >
                    <option value="applicant">출원인(AP)</option>
                  </select>
                  <input
                    aria-label="인명정보"
                    value={rowValue(personField)}
                    onFocus={() => searchField !== personField && selectField(personField)}
                    onChange={(event) => setRowValue(personField, event.target.value)}
                    placeholder="예) 대한민국, 삼성중공업"
                  />
                  <div style={andStyle}>AND</div>
                  <span style={{ textAlign: "center", fontSize: "22px", color: "#6b7788" }}>＋</span>
                </div>
              </div>
            </div>

            <p style={{ margin: "10px 0 0", color: "#627084", fontSize: "13px" }}>
              현재 수집 엔진은 한 번의 요청에서 하나의 검색 항목을 사용하므로, 입력한 행이 실제 검색 조건으로 적용됩니다.
            </p>

            <div className="form-grid three-columns" style={{ marginTop: "20px" }}>
              <div className="field-group">
                <label htmlFor="dateFilterType">기간 기준</label>
                <select
                  id="dateFilterType"
                  value={dateFilterType}
                  onChange={(event) => setDateFilterType(event.target.value as DateFilterType)}
                >
                  <option value="none">기간 제한 없음</option>
                  <option value="application">출원일</option>
                  <option value="registration">등록일</option>
                </select>
              </div>

              {dateFilterType !== "none" && (
                <>
                  <div className="field-group">
                    <label htmlFor="dateStartYear">시작 연월</label>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <select
                        id="dateStartYear"
                        value={dateStartYear}
                        onChange={(event) => setDateStartYear(event.target.value)}
                      >
                        {YEAR_OPTIONS.map((year) => (
                          <option key={year} value={year}>{year}년</option>
                        ))}
                      </select>
                      <select
                        aria-label="시작 월"
                        value={dateStartMonth}
                        onChange={(event) => setDateStartMonth(event.target.value)}
                      >
                        {MONTH_OPTIONS.map((month) => (
                          <option key={month} value={month}>{month}월</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="field-group">
                    <label htmlFor="dateEndYear">종료 연월</label>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <select
                        id="dateEndYear"
                        value={dateEndYear}
                        onChange={(event) => setDateEndYear(event.target.value)}
                      >
                        {YEAR_OPTIONS.map((year) => (
                          <option key={year} value={year}>{year}년</option>
                        ))}
                      </select>
                      <select
                        aria-label="종료 월"
                        value={dateEndMonth}
                        onChange={(event) => setDateEndMonth(event.target.value)}
                      >
                        {MONTH_OPTIONS.map((month) => (
                          <option key={month} value={month}>{month}월</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </>
              )}

              <div className="field-group">
                <label htmlFor="maxResults">최대 수집 건수</label>
                <select
                  id="maxResults"
                  value={maxResults}
                  onChange={(event) => setMaxResults(Number(event.target.value))}
                >
                  <option value={10}>10건</option>
                  <option value={30}>30건</option>
                  <option value={50}>50건</option>
                  <option value={100}>100건</option>
                </select>
              </div>

              <label className="option-card compact-option">
                <input
                  type="checkbox"
                  checked={downloadPdf}
                  onChange={(event) => setDownloadPdf(event.target.checked)}
                />
                <span>
                  <strong>공개전문 PDF 저장</strong>
                  <small>가능한 특허의 공개전문을 Storage에 저장</small>
                </span>
              </label>
            </div>
          </div>

          <div className="form-section">
            <div className="section-heading">
              <h2>3. 결과표 출력 항목</h2>
              <p>수집 완료 후 별도 결과 장표에 표시할 항목을 선택합니다.</p>
            </div>
            <div className="option-grid">
              {OUTPUT_OPTIONS.map((option) => (
                <label className="option-card" key={option.value}>
                  <input
                    type="checkbox"
                    checked={outputFields.includes(option.value)}
                    onChange={() => toggleOutputField(option.value)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {error && <p className="error">{error}</p>}
          <div className="form-actions right">
            <button type="submit">입력값 검토</button>
          </div>
        </form>
      ) : (
        <section className="card review-card">
          <div className="review-header">
            <div>
              <p className="eyebrow">REQUEST REVIEW</p>
              <h2>입력값 최종 검토</h2>
              <p>아래 내용으로 수집 작업을 등록하고 결과 장표를 생성합니다.</p>
            </div>
            <span className="review-badge">등록 전</span>
          </div>

          <dl className="review-list">
            {reviewRows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          <div className="notice subtle">
            작업 등록 후에는 <strong>내 작업</strong>과 <strong>결과 장표</strong> 화면에서 입력 조건, 진행 상태, 수집 결과를 함께 확인할 수 있습니다.
          </div>

          {error && <p className="error">{error}</p>}

          <div className="form-actions split">
            <button
              type="button"
              className="button secondary"
              onClick={() => setStep("input")}
              disabled={submitting}
            >
              입력 수정
            </button>
            <button type="button" onClick={submitJob} disabled={submitting}>
              {submitting ? "등록 중..." : "검토 완료·수집 등록"}
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
