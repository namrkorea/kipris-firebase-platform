import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "../../../lib/firebase-admin";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type PatentRow = {
  id: string;
  application_number?: unknown;
  invention_title?: unknown;
  applicant_name?: unknown;
  ipc_number?: unknown;
  application_date?: unknown;
  abstract?: unknown;
  register_status?: unknown;
  is_public?: boolean;
  updated_at?: unknown;
  [key: string]: unknown;
};

function safeSearchText(value: string): string {
  return value
    .trim()
    .slice(0, 100)
    .toLowerCase();
}

function safeLimit(value: string | null): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(
    Math.max(Math.trunc(parsed), 1),
    MAX_LIMIT,
  );
}

function searchable(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

function timestampMillis(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }

  const timestamp = value as {
    toMillis?: () => number;
  };

  if (typeof timestamp.toMillis === "function") {
    return timestamp.toMillis();
  }

  return 0;
}

export async function GET(request: NextRequest) {
  try {
    const q = safeSearchText(
      request.nextUrl.searchParams.get("q") ?? "",
    );

    const limit = safeLimit(
      request.nextUrl.searchParams.get("limit"),
    );

    const snapshot = await adminDb
      .collection("patents")
      .select(
        "application_number",
        "invention_title",
        "applicant_name",
        "ipc_number",
        "application_date",
        "abstract",
        "register_status",
        "is_public",
        "updated_at",
      )
      .get();

    const rows: PatentRow[] = snapshot.docs
      .map((document): PatentRow => {
        const data =
          document.data() as Record<string, unknown>;

        return {
          id: document.id,
          ...data,
        };
      })

      // 현재 Firebase 기존 자료에는 is_public이 없음.
      // false로 명시된 자료만 제외.
      .filter(
        (patent) => patent.is_public !== false,
      )

      // 제목 / 출원인 / IPC / 출원번호 검색
      .filter((patent) => {
        if (!q) {
          return true;
        }

        return [
          patent.invention_title,
          patent.applicant_name,
          patent.ipc_number,
          patent.application_number,
        ].some((value) =>
          searchable(value).includes(q),
        );
      })

      // created_at이 없으므로 updated_at 최신순
      .sort(
        (a, b) =>
          timestampMillis(b.updated_at) -
          timestampMillis(a.updated_at),
      )

      .slice(0, limit);

    const data = rows.map((row) => {
      const {
        is_public: _isPublic,
        updated_at: _updatedAt,
        ...patent
      } = row;

      return patent;
    });

    return NextResponse.json(
      { data },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (caught) {
    console.error(
      "Public patent search API failed:",
      caught,
    );

    return NextResponse.json(
      {
        error: "검색 결과를 불러오지 못했습니다.",
      },
      {
        status: 500,
      },
    );
  }
}