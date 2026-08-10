import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "../../../../lib/firebase-admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_VIEW_TOKEN = "public";

function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => toPlain(item));
  if (typeof value !== "object") return value;

  const maybeTimestamp = value as { toDate?: () => Date };
  if (typeof maybeTimestamp.toDate === "function") {
    return maybeTimestamp.toDate().toISOString();
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === "public_token" || key === "requester_hash") continue;
    result[key] = toPlain(item);
  }
  return result;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const token = request.nextUrl.searchParams.get("token")?.trim() || "";
    const includeResults = request.nextUrl.searchParams.get("includeResults") === "1";

    if (
      !UUID_PATTERN.test(id) ||
      (token && token !== PUBLIC_VIEW_TOKEN && !UUID_PATTERN.test(token))
    ) {
      return NextResponse.json(
        { error: "작업 확인 정보가 올바르지 않습니다." },
        { status: 400 },
      );
    }

    const jobRef = adminDb.collection("collection_jobs").doc(id);
    const jobSnapshot = await jobRef.get();

    if (!jobSnapshot.exists) {
      return NextResponse.json({ error: "작업을 찾을 수 없습니다." }, { status: 404 });
    }

    const jobData = jobSnapshot.data() ?? {};

    // 실제 UUID 토큰이 전달된 경우에만 소유자 토큰을 검증한다.
    // "public"은 다른 PC에서도 결과 장표를 볼 수 있게 하는 읽기 전용 표식이다.
    if (
      token &&
      token !== PUBLIC_VIEW_TOKEN &&
      String(jobData.public_token ?? "") !== token
    ) {
      return NextResponse.json({ error: "작업을 찾을 수 없습니다." }, { status: 404 });
    }

    const plainJob = toPlain(jobData) as Record<string, unknown>;

    if (!includeResults) {
      return NextResponse.json(
        { id: jobSnapshot.id, ...plainJob },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const resultsSnapshot = await jobRef.collection("results").get();
    const results = (
      await Promise.all(
        resultsSnapshot.docs.map(async (resultDocument, index) => {
          const relation = resultDocument.data();
          const patentId = String(relation.patent_id ?? resultDocument.id).trim();
          if (!patentId) return null;

          const patentSnapshot = await adminDb.collection("patents").doc(patentId).get();
          if (!patentSnapshot.exists) return null;

          const patent = toPlain(patentSnapshot.data() ?? {}) as Record<string, unknown>;
          const displayOrder =
            typeof relation.display_order === "number" ? relation.display_order : index + 1;

          return { ...patent, id: patentSnapshot.id, display_order: displayOrder };
        }),
      )
    ).filter((row) => row !== null);

    results.sort(
      (a, b) => Number(a.display_order ?? 0) - Number(b.display_order ?? 0),
    );

    return NextResponse.json(
      { id: jobSnapshot.id, ...plainJob, results },
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
