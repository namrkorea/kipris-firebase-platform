export type OutputField =
  | "applicationNumber"
  | "applicant"
  | "ipc"
  | "dates"
  | "status"
  | "abstract"
  | "pdf";

export type StoredJob = {
  id: string;
  token: string;
  queryText: string;
  createdAt: string;
  reportTitle?: string;
  reviewPurpose?: string;
  outputFields?: OutputField[];
};

export const JOB_STORAGE_KEY = "kipris-public-jobs";

export const DEFAULT_OUTPUT_FIELDS: OutputField[] = [
  "applicationNumber",
  "applicant",
  "ipc",
  "dates",
  "status",
  "abstract",
  "pdf",
];

function isOutputField(value: unknown): value is OutputField {
  return [
    "applicationNumber",
    "applicant",
    "ipc",
    "dates",
    "status",
    "abstract",
    "pdf",
  ].includes(String(value));
}

function normalizeStoredJob(item: unknown): StoredJob | null {
  if (!item || typeof item !== "object") return null;

  const value = item as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    typeof value.token !== "string" ||
    typeof value.queryText !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    token: value.token,
    queryText: value.queryText,
    createdAt: value.createdAt,
    reportTitle:
      typeof value.reportTitle === "string" ? value.reportTitle : undefined,
    reviewPurpose:
      typeof value.reviewPurpose === "string" ? value.reviewPurpose : undefined,
    outputFields: Array.isArray(value.outputFields)
      ? value.outputFields.filter(isOutputField)
      : undefined,
  };
}

export function readStoredJobs(): StoredJob[] {
  if (typeof window === "undefined") return [];

  const raw = window.localStorage.getItem(JOB_STORAGE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeStoredJob)
      .filter((item): item is StoredJob => item !== null);
  } catch {
    return [];
  }
}

export function saveStoredJob(job: StoredJob): void {
  if (typeof window === "undefined") return;

  const jobs = readStoredJobs();
  const next = [job, ...jobs.filter((item) => item.id !== job.id)].slice(0, 50);
  window.localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(next));
}

export function removeStoredJob(id: string): void {
  if (typeof window === "undefined") return;

  const next = readStoredJobs().filter((item) => item.id !== id);
  if (next.length === 0) {
    window.localStorage.removeItem(JOB_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(next));
}

export function clearStoredJobs(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(JOB_STORAGE_KEY);
}

export function findStoredJob(id: string): StoredJob | undefined {
  return readStoredJobs().find((item) => item.id === id);
}

export function getOutputFields(job?: StoredJob): OutputField[] {
  return job?.outputFields && job.outputFields.length > 0
    ? job.outputFields
    : DEFAULT_OUTPUT_FIELDS;
}
