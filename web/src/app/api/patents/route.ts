import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

const SELECT_FIELDS =
  "id,application_number,invention_title,applicant_name,ipc_number,application_date,abstract,register_status";

function serverClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const secret = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!url || !secret) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SECRET_KEY가 설정되지 않았습니다.",
    );
  }

  return createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function safeSearchText(value: string): string {
  return value
    .trim()
    .slice(0, 100)
    .replace(/[,%()]/g, " ")
    .replace(/\s+/g, " ");
}

export async function GET(request: NextRequest) {
  try {
    const supabase = serverClient();
    const q = safeSearchText(request.nextUrl.searchParams.get("q") ?? "");
    const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
      : 50;

    // 004_performance.sql이 적용된 경우 인덱스 기반 RPC를 우선 사용합니다.
    const rpc = await supabase.rpc("search_public_patents", {
      p_query: q,
      p_limit: limit,
    });

    if (!rpc.error) {
      return NextResponse.json({ data: rpc.data ?? [] });
    }

    // 아직 성능 SQL을 적용하지 않았거나 RPC가 일시적으로 실패해도
    // 공개 검색 화면이 멈추지 않도록 서버 권한으로 안전하게 대체 조회합니다.
    console.warn("search_public_patents RPC fallback:", rpc.error.message);

    let query = supabase
      .from("patents")
      .select(SELECT_FIELDS)
      .eq("is_public", true)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (q) {
      query = query.or(
        `invention_title.ilike.%${q}%,applicant_name.ilike.%${q}%,ipc_number.ilike.%${q}%,application_number.ilike.%${q}%`,
      );
    }

    const fallback = await query;
    if (fallback.error) {
      console.error("Public patent fallback search failed:", fallback.error);
      return NextResponse.json(
        { error: "검색 결과를 불러오지 못했습니다." },
        { status: 500 },
      );
    }

    return NextResponse.json({ data: fallback.data ?? [] });
  } catch (caught) {
    console.error("Public patent search API failed:", caught);
    return NextResponse.json(
      { error: "검색 서버 설정 또는 연결을 확인하세요." },
      { status: 500 },
    );
  }
}
