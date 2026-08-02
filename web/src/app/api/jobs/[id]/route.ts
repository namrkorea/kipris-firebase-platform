import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function serverConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!supabaseUrl || !secretKey) {
    throw new Error("Supabase 서버 환경변수가 비어 있습니다.");
  }

  return { supabaseUrl, secretKey };
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

function normalizePatentRelation(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return first && typeof first === "object"
      ? (first as Record<string, unknown>)
      : null;
  }
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const token = request.nextUrl.searchParams.get("token")?.trim() || "";
    const includeResults =
      request.nextUrl.searchParams.get("includeResults") === "1";

    if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(token)) {
      return NextResponse.json(
        { error: "작업 확인 정보가 올바르지 않습니다." },
        { status: 400 },
      );
    }

    const { supabaseUrl, secretKey } = serverConfig();
    const supabase = createServerClient(supabaseUrl, secretKey);

    const { data, error } = await supabase
      .from("collection_jobs")
      .select(
        "id,query_text,search_field,max_results,download_pdf,report_title,review_purpose,output_fields,status,progress_current,progress_total,result_count,error_message,created_at,started_at,completed_at",
      )
      .eq("id", id)
      .eq("public_token", token)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: "작업 상태를 확인하지 못했습니다." },
        { status: 500 },
      );
    }

    if (!data) {
      return NextResponse.json(
        { error: "작업을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    if (!includeResults) {
      return NextResponse.json(data, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const { data: rows, error: resultError } = await supabase
      .from("job_patents")
      .select(
        `display_order,
        patents(
          id,
          application_number,
          invention_title,
          applicant_name,
          ipc_number,
          application_date,
          open_number,
          open_date,
          publication_number,
          publication_date,
          register_number,
          register_date,
          register_status,
          abstract,
          pdf_storage_path
        )`,
      )
      .eq("job_id", id)
      .order("display_order", { ascending: true });

    if (resultError) {
      return NextResponse.json(
        { error: "특허 결과를 불러오지 못했습니다." },
        { status: 500 },
      );
    }

    const results = (rows ?? [])
      .map((row) => {
        const patent = normalizePatentRelation(row.patents);
        return patent
          ? {
              display_order: row.display_order,
              ...patent,
            }
          : null;
      })
  
      .filter(
             (row): row is NonNullable<typeof row> => row !== null,
             );
    return NextResponse.json(
      { ...data, results },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (caught) {
    console.error("Public job lookup failed:", caught);
    return NextResponse.json(
      { error: "서버 설정 또는 연결을 확인하세요." },
      { status: 500 },
    );
  }
}
