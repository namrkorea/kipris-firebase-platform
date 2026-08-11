import { NextResponse } from "next/server";
import { adminDb } from "../../../lib/firebase-admin";

const DEFAULT_MONTHLY_LIMIT = 1000;

function currentSeoulPeriod(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  return `${year}-${month}`;
}

export async function GET() {
  try {
    const period = currentSeoulPeriod();
    const snapshot = await adminDb
      .collection("kipris_api_usage")
      .doc(period)
      .get();

    const data = snapshot.exists ? snapshot.data() ?? {} : {};
    const count = Math.max(0, Number(data.call_count ?? 0));
    const limit = Math.max(1, Number(data.monthly_limit ?? DEFAULT_MONTHLY_LIMIT));
    const remaining = Math.max(0, limit - count);

    return NextResponse.json(
      {
        period,
        count,
        limit,
        remaining,
        percent: Math.min(100, Math.round((count / limit) * 1000) / 10),
        limitExceeded: Boolean(data.limit_exceeded),
        trackingBasis: "프로그램에서 실제 호출한 KIPRIS Open API 요청을 기능 적용 이후부터 누적한 값",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (caught) {
    console.error("KIPRIS usage load failed:", caught);
    return NextResponse.json(
      { error: "KIPRIS API 사용량을 불러오지 못했습니다." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
