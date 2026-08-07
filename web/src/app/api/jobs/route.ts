import { createHash } from "node:crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const requestSalt = process.env.PUBLIC_REQUEST_SALT?.trim();

  if (!supabaseUrl || !secretKey || !requestSalt) {
    throw new Error(
      "서버 환경변수 NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, PUBLIC_REQUEST_SALT를 확인하세요.",
    );
  }

  return {
    supabaseUrl,
    secretKey,
    requestSalt,
  };
}

function createServerClient(supabaseUrl: string, secretKey: string) {
  return createClient(supabaseUrl, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function clientFingerprint(request: NextRequest, salt: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip =
    forwarded?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
  const userAgent = request.headers.get("user-agent")?.slice(0, 300) || "unknown";

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

function parseKiprisItems(xml: string, maxResults: number): FastPatent[] {
  const itemPattern =
    /<(?:[\w.-]+:)?item\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?item>/gi;
  const rows: FastPatent[] = [];
  const seen = new Set<string>();

  for (const match of xml.matchAll(itemPattern)) {
    const itemXml = match[1];
    const applicationNumber = xmlText(itemXml, "applicationNumber");
    if (!applicationNumber || seen.has(applicationNumber)) continue;
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
      publicationNumber: xmlText(itemXml, "publicationNumber"),
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

    if (rows.length >= maxResults) break;
  }

  return rows;
}

async function searchKiprisFast(
  searchField: string,
  queryText: string,
  maxResults: number,
): Promise<FastPatent[] | null> {
  const serviceKey = process.env.KIPRIS_SERVICE_KEY?.trim();
  const searchUrl = process.env.KIPRIS_SEARCH_URL?.trim();
  if (!serviceKey || !searchUrl) return null;

  const url = new URL(searchUrl);
  url.searchParams.set("ServiceKey", serviceKey);
  url.searchParams.set(searchField, queryText);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", String(maxResults));
  url.searchParams.set("sortSpec", "PD");
  url.searchParams.set("descSort", "true");

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          Accept: "application/xml,text/xml,*/*",
          "User-Agent": "KIPRIS-Public-Platform/1.0",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`KIPRIS HTTP ${response.status}`);
      }

      const xml = (await response.text()).trim();
      if (!xml) throw new Error("KIPRIS가 빈 응답을 반환했습니다.");

      const resultCode = xmlText(xml, "resultCode");
      if (resultCode && resultCode !== "00" && resultCode !== "0") {
        throw new Error(
          `KIPRIS 오류 ${resultCode}: ${xmlText(xml, "resultMsg") || "알 수 없는 오류"}`,
        );
      }

      return parseKiprisItems(xml, maxResults);
    } catch (caught) {
      lastError = caught;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("KIPRIS 빠른 검색에 실패했습니다.");
}

async function saveFastResults(
  supabase: SupabaseClient,
  jobId: string,
  items: FastPatent[],
): Promise<void> {
  let patentIds = new Map<string, string>();

  // 성능 SQL이 적용된 환경에서는 RPC 한 번으로 저장합니다.
  const bulk = await supabase.rpc("bulk_save_patent_results", {
    p_job_id: jobId,
    p_patents: items,
  });

  if (!bulk.error) {
    for (const row of (bulk.data ?? []) as Array<Record<string, unknown>>) {
      const applicationNumber = String(row.application_number ?? "");
      const patentId = String(row.patent_id ?? "");
      if (applicationNumber && patentId) {
        patentIds.set(applicationNumber, patentId);
      }
    }
  } else {
    // 004_performance.sql을 아직 적용하지 않은 경우에도 동작하도록
    // 기존 테이블에 일괄 upsert하는 호환 경로를 둡니다.
    console.warn("bulk_save_patent_results fallback:", bulk.error.message);
    const records = items.map((item) => ({
      ...item,
      detail_xml: "",
      is_public: true,
    }));

    if (records.length > 0) {
      const saved = await supabase
        .from("patents")
        .upsert(records, { onConflict: "application_number" })
        .select("id,application_number");

      if (saved.error) throw saved.error;
      for (const row of saved.data ?? []) {
        if (row.application_number && row.id) {
          patentIds.set(String(row.application_number), String(row.id));
        }
      }

      if (patentIds.size < items.length) {
        const lookup = await supabase
          .from("patents")
          .select("id,application_number")
          .in(
            "application_number",
            items.map((item) => item.application_number),
          );
        if (lookup.error) throw lookup.error;
        for (const row of lookup.data ?? []) {
          if (row.application_number && row.id) {
            patentIds.set(String(row.application_number), String(row.id));
          }
        }
      }

      const links = items
        .map((item, index) => {
          const patentId = patentIds.get(item.application_number);
          return patentId
            ? {
                job_id: jobId,
                patent_id: patentId,
                display_order: index + 1,
              }
            : null;
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);

      if (links.length > 0) {
        const linked = await supabase
          .from("job_patents")
          .upsert(links, { onConflict: "job_id,patent_id" });
        if (linked.error) throw linked.error;
      }
    }
  }

  const resultCount = items.filter((item) =>
    patentIds.has(item.application_number),
  ).length;
  const now = new Date().toISOString();
  const completed = await supabase
    .from("collection_jobs")
    .update({
      status: "completed",
      progress_total: items.length,
      progress_current: items.length,
      result_count: resultCount,
      error_message: null,
      completed_at: now,
    })
    .eq("id", jobId);

  if (completed.error) throw completed.error;
}

async function tryFastPath(
  supabase: SupabaseClient,
  jobId: string,
  searchField: string,
  queryText: string,
  maxResults: number,
  downloadPdf: boolean,
): Promise<boolean> {
  const configuredLimit = Number(
    process.env.KIPRIS_FAST_PATH_MAX_RESULTS?.trim() || "30",
  );
  const fastLimit = Number.isFinite(configuredLimit)
    ? Math.min(Math.max(Math.trunc(configuredLimit), 1), 50)
    : 30;

  if (downloadPdf || maxResults > fastLimit) return false;

  const items = await searchKiprisFast(searchField, queryText, maxResults);
  if (items === null) return false;

  await saveFastResults(supabase, jobId, items);
  return true;
}

async function triggerGitHubWorker(jobId: string): Promise<void> {
  const token = process.env.GITHUB_ACTIONS_TOKEN?.trim();
  if (!token) {
    console.warn(
      "GITHUB_ACTIONS_TOKEN이 없어 GitHub Worker 즉시 실행을 건너뜁니다. 예약 실행이 대기 작업을 처리합니다.",
    );
    return;
  }

  try {
    const response = await fetch(
      "https://api.github.com/repos/namrkorea/kipris-public-platform/dispatches",
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: JSON.stringify({
          event_type: "kipris-job-created",
          client_payload: {
            job_id: jobId,
          },
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
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
    console.error("GitHub Worker dispatch error:", caught);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { supabaseUrl, secretKey, requestSalt } = serverConfig();
    const body = (await request.json()) as Record<string, unknown>;

    const queryText =
      typeof body.queryText === "string" ? body.queryText.trim() : "";
    const searchField =
      typeof body.searchField === "string" ? body.searchField : "";
    const maxResults = Number(body.maxResults);
    const downloadPdf = body.downloadPdf !== false;
    const reportTitle =
      typeof body.reportTitle === "string"
        ? body.reportTitle.trim()
        : "특허 검색·검토 결과";
    const reviewPurpose =
      typeof body.reviewPurpose === "string" ? body.reviewPurpose.trim() : "";
    const rawOutputFields = Array.isArray(body.outputFields)
      ? body.outputFields
      : [];
    const outputFields = rawOutputFields.filter(
      (value): value is string =>
        typeof value === "string" && ALLOWED_OUTPUT_FIELDS.has(value),
    );

    if (queryText.length < 2 || queryText.length > 200) {
      return NextResponse.json(
        { error: "검색어는 2자 이상 200자 이하로 입력하세요." },
        { status: 400 },
      );
    }

    if (reportTitle.length > 100 || reviewPurpose.length > 500) {
      return NextResponse.json(
        { error: "결과표 제목 또는 검토 목적의 입력 길이를 확인하세요." },
        { status: 400 },
      );
    }

    if (
      rawOutputFields.length !== outputFields.length ||
      outputFields.length > ALLOWED_OUTPUT_FIELDS.size
    ) {
      return NextResponse.json(
        { error: "결과표 출력 항목이 올바르지 않습니다." },
        { status: 400 },
      );
    }

    if (!ALLOWED_FIELDS.has(searchField)) {
      return NextResponse.json(
        { error: "지원하지 않는 검색 항목입니다." },
        { status: 400 },
      );
    }

    if (
      !Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 100
    ) {
      return NextResponse.json(
        { error: "수집 건수는 1건 이상 100건 이하로 선택하세요." },
        { status: 400 },
      );
    }

    const requesterHash = clientFingerprint(request, requestSalt);
    const supabase = createServerClient(supabaseUrl, secretKey);

    const { data, error } = await supabase.rpc(
      "create_public_collection_job",
      {
        p_query_text: queryText,
        p_search_field: searchField,
        p_max_results: maxResults,
        p_download_pdf: downloadPdf,
        p_requester_hash: requesterHash,
        p_report_title: reportTitle || "특허 검색·검토 결과",
        p_review_purpose: reviewPurpose,
        p_output_fields:
          outputFields.length > 0
            ? outputFields
            : Array.from(ALLOWED_OUTPUT_FIELDS),
      },
    );

    if (error) {
      const status = error.message.includes("한도") ? 429 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.id || !row?.public_token) {
      return NextResponse.json(
        { error: "작업 등록 결과를 확인할 수 없습니다." },
        { status: 500 },
      );
    }

    const jobId = String(row.id);
    let fastPath = false;
    try {
      fastPath = await tryFastPath(
        supabase,
        jobId,
        searchField,
        queryText,
        maxResults,
        downloadPdf,
      );
    } catch (caught) {
      console.error("KIPRIS fast path failed; falling back to GitHub:", caught);
    }

    if (!fastPath) {
      await triggerGitHubWorker(jobId);
    }

    return NextResponse.json(
      {
        id: jobId,
        token: String(row.public_token),
        mode: fastPath ? "fast" : "queue",
      },
      { status: 201 },
    );
  } catch (caught) {
    console.error("Public job creation failed:", caught);
    return NextResponse.json(
      { error: "서버 설정 또는 연결을 확인하세요." },
      { status: 500 },
    );
  }
}
