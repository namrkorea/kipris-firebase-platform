import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
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

    return NextResponse.json(
      {
        id: String(row.id),
        token: String(row.public_token),
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
