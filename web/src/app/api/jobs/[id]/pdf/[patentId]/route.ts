import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function serverConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const pdfBucket = process.env.SUPABASE_PDF_BUCKET?.trim() || "patent-pdfs";

  if (!supabaseUrl || !secretKey) {
    throw new Error("Supabase 서버 환경변수가 비어 있습니다.");
  }

  return { supabaseUrl, secretKey, pdfBucket };
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

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; patentId: string }> },
) {
  try {
    const { id, patentId } = await context.params;
    const token = request.nextUrl.searchParams.get("token")?.trim() || "";

    if (
      !UUID_PATTERN.test(id) ||
      !UUID_PATTERN.test(patentId) ||
      !UUID_PATTERN.test(token)
    ) {
      return NextResponse.json(
        { error: "PDF 확인 정보가 올바르지 않습니다." },
        { status: 400 },
      );
    }

    const { supabaseUrl, secretKey, pdfBucket } = serverConfig();
    const supabase = createServerClient(supabaseUrl, secretKey);

    const { data: job, error: jobError } = await supabase
      .from("collection_jobs")
      .select("id")
      .eq("id", id)
      .eq("public_token", token)
      .maybeSingle();

    if (jobError) {
      console.error("PDF job lookup failed:", jobError);
      return NextResponse.json(
        { error: "작업 정보를 확인하지 못했습니다." },
        { status: 500 },
      );
    }

    if (!job) {
      return NextResponse.json(
        { error: "작업을 찾을 수 없거나 확인 토큰이 만료되었습니다." },
        { status: 404 },
      );
    }

    const { data: relation, error: relationError } = await supabase
      .from("job_patents")
      .select("patent_id")
      .eq("job_id", id)
      .eq("patent_id", patentId)
      .maybeSingle();

    if (relationError) {
      console.error("PDF relation lookup failed:", relationError);
      return NextResponse.json(
        { error: "작업과 특허의 연결 정보를 확인하지 못했습니다." },
        { status: 500 },
      );
    }

    if (!relation) {
      return NextResponse.json(
        { error: "이 작업에 포함된 특허가 아닙니다." },
        { status: 404 },
      );
    }

    const { data: patent, error: patentError } = await supabase
      .from("patents")
      .select("pdf_storage_path")
      .eq("id", patentId)
      .maybeSingle();

    if (patentError) {
      console.error("PDF patent lookup failed:", patentError);
      return NextResponse.json(
        { error: "특허 PDF 정보를 확인하지 못했습니다." },
        { status: 500 },
      );
    }

    const storagePath = patent?.pdf_storage_path?.trim();
    if (!storagePath) {
      return NextResponse.json(
        { error: "저장된 PDF가 없습니다." },
        { status: 404 },
      );
    }

    const { data: signed, error: signedError } = await supabase.storage
      .from(pdfBucket)
      .createSignedUrl(storagePath, 300);

    if (signedError || !signed?.signedUrl) {
      console.error("PDF signed URL creation failed:", signedError);
      return NextResponse.json(
        { error: "PDF 열기 주소를 만들지 못했습니다." },
        { status: 500 },
      );
    }

    const response = NextResponse.redirect(signed.signedUrl, 302);
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (caught) {
    console.error("Public PDF view failed:", caught);
    return NextResponse.json(
      { error: "서버 설정 또는 Storage 연결을 확인하세요." },
      { status: 500 },
    );
  }
}
