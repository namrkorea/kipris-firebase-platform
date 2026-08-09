import { createHash, randomUUID } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "../../../lib/firebase-admin";

const ALLOWED_OUTPUT_FIELDS = new Set([
  "applicationNumber",
  "applicant",
  "ipc",
  "dates",
  "status",
  "abstract",
  "pdf",
]);

const ALLOWED_FIELDS = new Set([
  "word",
  "inventionTitle",
  "applicant",
  "ipcNumber",
  "applicationNumber",
  "publicationNumber",
  "registerNumber",
]);

type FastPatent = {
  application_number: string;
  invention_title: string;
  applicant_name: string;
  ipc_number: string;
  register_status: string;
  register_number: string;
  register_date: string;
  application_date: string;
  open_number: string;
  open_date: string;
  publication_number: string;
  publication_date: string;
  abstract: string;
  drawing_url: string;
  big_drawing_url: string;
  raw_search_json: Record<string, string>;
};

function serverConfig() {
  const requestSalt = process.env.PUBLIC_REQUEST_SALT?.trim();

  if (!requestSalt) {
    throw new Error(
      "서버 환경변수 PUBLIC_REQUEST_SALT를 확인하세요.",
    );
  }

  return { requestSalt };
}

class PublicRequestLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicRequestLimitError";
  }
}

function patentDocumentId(applicationNumber: string): string {
  return createHash("sha256")
    .update(applicationNumber.trim())
    .digest("hex")
    .slice(0, 40);
}

async function createPublicJob(params: {
  queryText: string;
  searchField: string;
  maxResults: number;
  downloadPdf: boolean;
  requesterHash: string;
  reportTitle: string;
  reviewPurpose: string;
  outputFields: string[];
}) {
  const jobId = randomUUID();
  const publicToken = randomUUID();

  const now = Timestamp.now();
  const nowMs = now.toMillis();
  const oneHourAgoMs = nowMs - 60 * 60 * 1000;
  const dayBucket = now.toDate().toISOString().slice(0, 10);

  const limitRef = adminDb
    .collection("public_request_limits")
    .doc(params.requesterHash);

  const jobRef = adminDb
    .collection("collection_jobs")
    .doc(jobId);

  await adminDb.runTransaction(async (transaction) => {
    const limitSnapshot = await transaction.get(limitRef);
    const limit = limitSnapshot.data() ?? {};

    const recentHourMs = Array.isArray(limit.recent_hour_ms)
      ? limit.recent_hour_ms
          .map((value: unknown) => Number(value))
          .filter(
            (value: number) =>
              Number.isFinite(value) && value >= oneHourAgoMs,
          )
      : [];

    const dailyCount =
      limit.day_bucket === dayBucket
        ? Number(limit.day_count ?? 0)
        : 0;

    if (recentHourMs.length >= 5) {
      throw new PublicRequestLimitError(
        "시간당 수집 요청 한도 5건을 초과했습니다.",
      );
    }

    if (dailyCount >= 20) {
      throw new PublicRequestLimitError(
        "하루 수집 요청 한도 20건을 초과했습니다.",
      );
    }

    transaction.set(
      limitRef,
      {
        recent_hour_ms: [...recentHourMs, nowMs],
        day_bucket: dayBucket,
        day_count: dailyCount + 1,
        updated_at: now,
      },
      { merge: true },
    );

    transaction.set(jobRef, {
      public_token: publicToken,
      requested_by: null,
      query_text: params.queryText,
      search_field: params.searchField,
      max_results: params.maxResults,
      download_pdf: params.downloadPdf,
      requester_hash: params.requesterHash,
      request_source: "public",
      report_title:
        params.reportTitle || "특허 검색·검토 결과",
      review_purpose: params.reviewPurpose,
      output_fields: params.outputFields,
      status: "queued",
      progress_total: params.maxResults,
      progress_current: 0,
      result_count: 0,
      error_message: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    });
  });

  return {
    id: jobId,
    public_token: publicToken,
  };
}

function clientFingerprint(request: NextRequest, salt: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip =
    forwarded?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
  const userAgent =
    request.headers.get("user-agent")?.slice(0, 300) || "unknown";

  return createHash("sha256")
    .update(`${salt}|${ip}|${userAgent}`)
    .digest("hex");
}

function decodeXml(value: string): string {
  return value
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlText(xml: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}>`,
    "i",
  );
  const match = xml.match(pattern);
  return match ? decodeXml(match[1]) : "";
}

function parseKiprisItems(
  xml: string,
  maxResults: number,
): FastPatent[] {
  const itemPattern =
    /<(?:[\w.-]+:)?item\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?item>/gi;
  const rows: FastPatent[] = [];
  const seen = new Set<string>();

  for (const match of xml.matchAll(itemPattern)) {
    const itemXml = match[1];
    const applicationNumber = xmlText(
      itemXml,
      "applicationNumber",
    );

    if (
      !applicationNumber ||
      seen.has(applicationNumber)
    ) {
      continue;
    }

    seen.add(applicationNumber);

    const raw = {
      applicationNumber,
      inventionTitle: xmlText(itemXml, "inventionTitle"),
      applicantName: xmlText(itemXml, "applicantName"),
      ipcNumber: xmlText(itemXml, "ipcNumber"),
      registerStatus: xmlText(itemXml, "registerStatus"),
      registerNumber: xmlText(itemXml, "registerNumber"),
      registerDate: xmlText(itemXml, "registerDate"),
      applicationDate: xmlText(itemXml, "applicationDate"),
      openNumber: xmlText(itemXml, "openNumber"),
      openDate: xmlText(itemXml, "openDate"),
      publicationNumber: xmlText(
        itemXml,
        "publicationNumber",
      ),
      publicationDate: xmlText(itemXml, "publicationDate"),
      astrtCont: xmlText(itemXml, "astrtCont"),
      drawing: xmlText(itemXml, "drawing"),
      bigDrawing: xmlText(itemXml, "bigDrawing"),
    };

    rows.push({
      application_number: applicationNumber,
      invention_title: raw.inventionTitle,
      applicant_name: raw.applicantName,
      ipc_number: raw.ipcNumber,
      register_status: raw.registerStatus,
      register_number: raw.registerNumber,
      register_date: raw.registerDate,
      application_date: raw.applicationDate,
      open_number: raw.openNumber,
      open_date: raw.openDate,
      publication_number: raw.publicationNumber,
      publication_date: raw.publicationDate,
      abstract: raw.astrtCont,
      drawing_url: raw.drawing,
      big_drawing_url: raw.bigDrawing,
      raw_search_json: raw,
    });

    if (rows.length >= maxResults) {
      break;
    }
  }

  return rows;
}

async function searchKiprisFast(
  searchField: string,
  queryText: string,
  maxResults: number,
): Promise<FastPatent[] | null> {
  const serviceKey =
    process.env.KIPRIS_SERVICE_KEY?.trim();
  const searchUrl =
    process.env.KIPRIS_SEARCH_URL?.trim();

  if (!serviceKey || !searchUrl) {
    return null;
  }

  const url = new URL(searchUrl);
  url.searchParams.set("ServiceKey", serviceKey);
  url.searchParams.set(searchField, queryText);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set(
    "numOfRows",
    String(maxResults),
  );
  url.searchParams.set("sortSpec", "PD");
  url.searchParams.set("descSort", "true");

  let lastError: unknown = null;

  for (
    let attempt = 1;
    attempt <= 2;
    attempt += 1
  ) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          Accept: "application/xml,text/xml,*/*",
          "User-Agent":
            "KIPRIS-Public-Platform/1.0",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(
          `KIPRIS HTTP ${response.status}`,
        );
      }

      const xml =
        (await response.text()).trim();

      if (!xml) {
        throw new Error(
          "KIPRIS가 빈 응답을 반환했습니다.",
        );
      }

      const resultCode =
        xmlText(xml, "resultCode");

      if (
        resultCode &&
        resultCode !== "00" &&
        resultCode !== "0"
      ) {
        throw new Error(
          `KIPRIS 오류 ${resultCode}: ${
            xmlText(xml, "resultMsg") ||
            "알 수 없는 오류"
          }`,
        );
      }

      return parseKiprisItems(
        xml,
        maxResults,
      );
    } catch (caught) {
      lastError = caught;

      if (attempt < 2) {
        await new Promise((resolve) =>
          setTimeout(resolve, 500),
        );
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        "KIPRIS 빠른 검색에 실패했습니다.",
      );
}

async function saveFastResults(
  jobId: string,
  items: FastPatent[],
): Promise<void> {
  const batch = adminDb.batch();
  const now = Timestamp.now();

  const jobRef = adminDb
    .collection("collection_jobs")
    .doc(jobId);

  for (
    let index = 0;
    index < items.length;
    index += 1
  ) {
    const item = items[index];

    const patentId =
      patentDocumentId(
        item.application_number,
      );

    const patentRef = adminDb
      .collection("patents")
      .doc(patentId);

    batch.set(
      patentRef,
      {
        ...item,
        is_public: true,
        updated_at: now,
      },
      { merge: true },
    );

    const resultRef = jobRef
      .collection("results")
      .doc(patentId);

    batch.set(
      resultRef,
      {
        patent_id: patentId,
        application_number:
          item.application_number,
        display_order: index + 1,
        saved_at: now,
      },
      { merge: true },
    );
  }

  batch.set(
    jobRef,
    {
      status: "completed",
      progress_total: items.length,
      progress_current: items.length,
      result_count: items.length,
      error_message: null,
      completed_at: now,
      updated_at: now,
    },
    { merge: true },
  );

  await batch.commit();
}

async function tryFastPath(
  jobId: string,
  searchField: string,
  queryText: string,
  maxResults: number,
  downloadPdf: boolean,
): Promise<boolean> {
  const configuredLimit = Number(
    process.env.KIPRIS_FAST_PATH_MAX_RESULTS?.trim() ||
      "30",
  );

  const fastLimit = Number.isFinite(
    configuredLimit,
  )
    ? Math.min(
        Math.max(
          Math.trunc(configuredLimit),
          1,
        ),
        50,
      )
    : 30;

  if (
    downloadPdf ||
    maxResults > fastLimit
  ) {
    return false;
  }

  const items = await searchKiprisFast(
    searchField,
    queryText,
    maxResults,
  );

  if (items === null) {
    return false;
  }

  await saveFastResults(
    jobId,
    items,
  );

  return true;
}

async function triggerGitHubWorker(
  jobId: string,
): Promise<void> {
  const token =
    process.env.GITHUB_ACTIONS_TOKEN?.trim();

  if (!token) {
    console.warn(
      "GITHUB_ACTIONS_TOKEN이 없어 GitHub Worker 즉시 실행을 건너뜁니다. 예약 실행이 대기 작업을 처리합니다.",
    );
    return;
  }

  try {
    const response = await fetch(
      "https://api.github.com/repos/namrkorea/kipris-firebase-platform/dispatches",
      {
        method: "POST",
        headers: {
          Accept:
            "application/vnd.github+json",
          Authorization:
            `Bearer ${token}`,
          "Content-Type":
            "application/json",
          "X-GitHub-Api-Version":
            "2026-03-10",
        },
        body: JSON.stringify({
          event_type:
            "kipris-job-created",
          client_payload: {
            job_id: jobId,
          },
        }),
        cache: "no-store",
        signal:
          AbortSignal.timeout(5000),
      },
    );

    if (!response.ok) {
      console.error(
        "GitHub Worker dispatch failed:",
        response.status,
        await response.text(),
      );
    }
  } catch (caught) {
    console.error(
      "GitHub Worker dispatch error:",
      caught,
    );
  }
}

export async function POST(
  request: NextRequest,
) {
  try {
    const { requestSalt } =
      serverConfig();

    const body =
      (await request.json()) as Record<
        string,
        unknown
      >;

    const queryText =
      typeof body.queryText === "string"
        ? body.queryText.trim()
        : "";

    const searchField =
      typeof body.searchField === "string"
        ? body.searchField
        : "";

    const maxResults =
      Number(body.maxResults);

    const downloadPdf =
      body.downloadPdf !== false;

    const reportTitle =
      typeof body.reportTitle === "string"
        ? body.reportTitle.trim()
        : "특허 검색·검토 결과";

    const reviewPurpose =
      typeof body.reviewPurpose === "string"
        ? body.reviewPurpose.trim()
        : "";

    const rawOutputFields =
      Array.isArray(body.outputFields)
        ? body.outputFields
        : [];

    const outputFields =
      rawOutputFields.filter(
        (value): value is string =>
          typeof value === "string" &&
          ALLOWED_OUTPUT_FIELDS.has(value),
      );

    if (
      queryText.length < 2 ||
      queryText.length > 200
    ) {
      return NextResponse.json(
        {
          error:
            "검색어는 2자 이상 200자 이하로 입력하세요.",
        },
        { status: 400 },
      );
    }

    if (
      reportTitle.length > 100 ||
      reviewPurpose.length > 500
    ) {
      return NextResponse.json(
        {
          error:
            "결과표 제목 또는 검토 목적의 입력 길이를 확인하세요.",
        },
        { status: 400 },
      );
    }

    if (
      rawOutputFields.length !==
        outputFields.length ||
      outputFields.length >
        ALLOWED_OUTPUT_FIELDS.size
    ) {
      return NextResponse.json(
        {
          error:
            "결과표 출력 항목이 올바르지 않습니다.",
        },
        { status: 400 },
      );
    }

    if (
      !ALLOWED_FIELDS.has(searchField)
    ) {
      return NextResponse.json(
        {
          error:
            "지원하지 않는 검색 항목입니다.",
        },
        { status: 400 },
      );
    }

    if (
      !Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 100
    ) {
      return NextResponse.json(
        {
          error:
            "수집 건수는 1건 이상 100건 이하로 선택하세요.",
        },
        { status: 400 },
      );
    }

    const requesterHash =
      clientFingerprint(
        request,
        requestSalt,
      );

    const job =
      await createPublicJob({
        queryText,
        searchField,
        maxResults,
        downloadPdf,
        requesterHash,
        reportTitle:
          reportTitle ||
          "특허 검색·검토 결과",
        reviewPurpose,
        outputFields:
          outputFields.length > 0
            ? outputFields
            : Array.from(
                ALLOWED_OUTPUT_FIELDS,
              ),
      });

    const jobId = job.id;

    let fastPath = false;

    try {
      fastPath =
        await tryFastPath(
          jobId,
          searchField,
          queryText,
          maxResults,
          downloadPdf,
        );
    } catch (caught) {
      console.error(
        "KIPRIS fast path failed; falling back to GitHub:",
        caught,
      );
    }

    if (!fastPath) {
      await triggerGitHubWorker(
        jobId,
      );
    }

    return NextResponse.json(
      {
        id: jobId,
        token: job.public_token,
        mode:
          fastPath
            ? "fast"
            : "queue",
      },
      { status: 201 },
    );
  } catch (caught) {
    console.error(
      "Public job creation failed:",
      caught,
    );

    if (
      caught instanceof
      PublicRequestLimitError
    ) {
      return NextResponse.json(
        {
          error: caught.message,
        },
        { status: 429 },
      );
    }

    return NextResponse.json(
      {
        error:
          "서버 설정 또는 연결을 확인하세요.",
      },
      { status: 500 },
    );
  }
}
