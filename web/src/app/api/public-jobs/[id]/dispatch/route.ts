import { NextRequest, NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../../../../../lib/firebase-admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const WORKFLOW_DISPATCH_URL =
  "https://api.github.com/repos/namrkorea/kipris-firebase-platform/actions/workflows/kipris-worker.yml/dispatches";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const token = request.nextUrl.searchParams.get("token")?.trim() || "";

    if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(token)) {
      return NextResponse.json(
        { error: "작업 확인 정보가 올바르지 않습니다." },
        { status: 400 },
      );
    }

    const jobRef = adminDb.collection("collection_jobs").doc(id);
    const snapshot = await jobRef.get();

    if (!snapshot.exists) {
      return NextResponse.json(
        { error: "작업을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    const data = snapshot.data() ?? {};
    if (String(data.public_token ?? "") !== token) {
      return NextResponse.json(
        { error: "이 작업의 Worker를 실행할 권한이 없습니다." },
        { status: 403 },
      );
    }

    const status = String(data.status ?? "queued");
    if (status !== "queued") {
      return NextResponse.json({
        ok: true,
        dispatch_state: "not_needed",
        message: "이미 Worker가 작업을 시작했거나 작업이 종료되었습니다.",
      });
    }

    const githubToken = process.env.GITHUB_ACTIONS_TOKEN?.trim();
    const now = Timestamp.now();

    if (!githubToken) {
      await jobRef.set(
        {
          dispatch_state: "missing_token",
          dispatch_message:
            "Vercel의 GITHUB_ACTIONS_TOKEN이 없어 즉시 실행하지 못했습니다. GitHub 예약 실행을 기다립니다.",
          dispatch_attempted_at: now,
          updated_at: now,
        },
        { merge: true },
      );

      return NextResponse.json(
        {
          ok: false,
          dispatch_state: "missing_token",
          message:
            "GITHUB_ACTIONS_TOKEN이 없어 GitHub Worker 즉시 실행을 요청하지 못했습니다.",
        },
        { status: 503 },
      );
    }

    try {
      const response = await fetch(
        WORKFLOW_DISPATCH_URL,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${githubToken}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ ref: "main" }),
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        },
      );

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        await jobRef.set(
          {
            dispatch_state: "failed",
            dispatch_message: `GitHub Worker 즉시 실행 요청 실패 (${response.status})`,
            dispatch_attempted_at: now,
            dispatch_error_detail: detail,
            dispatch_method: "workflow_dispatch",
            updated_at: now,
          },
          { merge: true },
        );

        return NextResponse.json(
          {
            ok: false,
            dispatch_state: "failed",
            message: `GitHub Worker 즉시 실행 요청이 실패했습니다. HTTP ${response.status}`,
          },
          { status: 502 },
        );
      }

      await jobRef.set(
        {
          dispatch_state: "sent",
          dispatch_message: "GitHub Worker 즉시 실행 요청을 보냈습니다.",
          dispatch_attempted_at: now,
          dispatch_error_detail: null,
          dispatch_method: "workflow_dispatch",
          updated_at: now,
        },
        { merge: true },
      );

      return NextResponse.json({
        ok: true,
        dispatch_state: "sent",
        message: "GitHub Worker 즉시 실행 요청을 보냈습니다.",
      });
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "알 수 없는 오류";

      await jobRef.set(
        {
          dispatch_state: "failed",
          dispatch_message: "GitHub Worker 즉시 실행 요청 중 연결 오류가 발생했습니다.",
          dispatch_attempted_at: now,
          dispatch_error_detail: message.slice(0, 500),
          dispatch_method: "workflow_dispatch",
          updated_at: now,
        },
        { merge: true },
      );

      return NextResponse.json(
        {
          ok: false,
          dispatch_state: "failed",
          message: "GitHub Worker 즉시 실행 요청 중 연결 오류가 발생했습니다.",
        },
        { status: 502 },
      );
    }
  } catch (caught) {
    console.error("Public job dispatch failed:", caught);
    return NextResponse.json(
      { error: "GitHub Worker 실행 요청 상태를 처리하지 못했습니다." },
      { status: 500 },
    );
  }
}
