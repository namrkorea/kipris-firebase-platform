import { NextResponse } from "next/server";
import { adminDb } from "../../../lib/firebase-admin";

function toIso(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const maybeTimestamp = value as { toDate?: () => Date };
  return typeof maybeTimestamp.toDate === "function"
    ? maybeTimestamp.toDate().toISOString()
    : null;
}

export async function GET() {
  try {
    const snapshot = await adminDb
      .collection("collection_jobs")
      .orderBy("created_at", "desc")
      .limit(100)
      .get();

    const jobs = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        query_text: String(data.query_text ?? ""),
        search_field: String(data.search_field ?? "word"),
        status: String(data.status ?? "queued"),
        progress_current: Number(data.progress_current ?? 0),
        progress_total: Number(data.progress_total ?? 0),
        result_count: Number(data.result_count ?? 0),
        report_title: data.report_title ? String(data.report_title) : null,
        review_purpose: data.review_purpose ? String(data.review_purpose) : null,
        output_fields: Array.isArray(data.output_fields) ? data.output_fields : null,
        error_message: data.error_message ? String(data.error_message) : null,
        created_at: toIso(data.created_at) ?? new Date(0).toISOString(),
      };
    });

    return NextResponse.json(
      { jobs },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (caught) {
    console.error("Public job list failed:", caught);
    return NextResponse.json(
      { error: "작업 목록을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
