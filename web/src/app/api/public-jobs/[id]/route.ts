import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "../../../../lib/firebase-admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const token = request.nextUrl.searchParams.get("token")?.trim() || "";

    if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(token)) {
      return NextResponse.json(
        { error: "삭제 확인 정보가 올바르지 않습니다." },
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
        { error: "이 작업을 삭제할 권한이 없습니다." },
        { status: 403 },
      );
    }

    const results = await jobRef.collection("results").get();
    let batch = adminDb.batch();
    let count = 0;

    for (const result of results.docs) {
      batch.delete(result.ref);
      count += 1;
      if (count >= 400) {
        await batch.commit();
        batch = adminDb.batch();
        count = 0;
      }
    }

    batch.delete(jobRef);
    await batch.commit();

    return NextResponse.json({ ok: true });
  } catch (caught) {
    console.error("Public job delete failed:", caught);
    return NextResponse.json(
      { error: "작업을 삭제하지 못했습니다." },
      { status: 500 },
    );
  }
}
