export const SEARCH_FIELD_LABELS: Record<string, string> = {
  word: "자유검색",
  inventionTitle: "발명의 명칭",
  applicant: "출원인",
  ipcNumber: "IPC",
  applicationNumber: "출원번호",
  publicationNumber: "공고번호",
  registerNumber: "등록번호",
};

export const JOB_STATUS_LABELS: Record<string, string> = {
  queued: "대기",
  running: "수집 중",
  completed: "완료",
  failed: "실패",
  cancelled: "취소",
};

export function searchFieldLabel(value: string): string {
  return SEARCH_FIELD_LABELS[value] ?? value;
}

export function jobStatusLabel(value: string): string {
  return JOB_STATUS_LABELS[value] ?? value;
}

export function formatPatentDate(value: string | null | undefined): string {
  if (!value) return "-";
  const digits = value.replace(/\D/g, "");
  if (digits.length === 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  return value;
}
