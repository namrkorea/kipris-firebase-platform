import { NextRequest, NextResponse } from "next/server";
import { adminBucket, adminDb } from "../../../../../../lib/firebase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATENT_ID_PATTERN = /^[0-9a-f]{40}$/i;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; patentId: string }> },
) {
  try {
    const { id, patentId } = await context.params;
    const token = request.nextUrl.searchParams.get("token")?.trim() || "";

    if (
      !UUID_PATTERN.test(id) ||
      (token && !UUID_PATTERN.test(token)) ||
      !PATENT_ID_PATTERN.test(patentId)
    ) {
      return NextResponse.json(
        { error: "PDF 확인 정보가 올바르지 않습니다." },
        { status: 400 },
      );
    }

    const jobRef = adminDb.collection("collection_jobs").doc(id);
    const jobSnapshot = await jobRef.get();

    if (!jobSnapshot.exists) {
      return NextResponse.json({ error: "작업을 찾을 수 없습니다." }, { status: 404 });
    }

    const jobData = jobSnapshot.data() ?? {};
    if (token && String(jobData.public_token ?? "") !== token) {
      return NextResponse.json({ error: "작업을 찾을 수 없습니다." }, { status: 404 });
    }

    const resultSnapshot = await jobRef.collection("results").doc(patentId).get();
    if (!resultSnapshot.exists) {
      return NextResponse.json(
        { error: "이 작업에 포함된 특허가 아닙니다." },
        { status: 404 },
      );
    }

    const patentSnapshot = await adminDb.collection("patents").doc(patentId).get();
    if (!patentSnapshot.exists) {
      return NextResponse.json({ error: "특허 정보를 찾을 수 없습니다." }, { status: 404 });
    }

    const patent = patentSnapshot.data() ?? {};
    const storagePath = String(patent.pdf_storage_path ?? "").trim();
    if (!storagePath) {
      return NextResponse.json({ error: "저장된 PDF가 없습니다." }, { status: 404 });
    }

    const applicationNumber = String(patent.application_number ?? "")
      .replace(/[^0-9A-Za-z_-]+/g, "")
      .trim();

    const candidatePaths = Array.from(
      new Set(
        [
          storagePath,
          applicationNumber ? `${applicationNumber}/${applicationNumber}.pdf` : "",
        ].filter(Boolean),
      ),
    );

    let pdfFile: ReturnType<typeof adminBucket.file> | null = null;
    for (const candidatePath of candidatePaths) {
      const candidateFile = adminBucket.file(candidatePath);
      const [exists] = await candidateFile.exists();
      if (exists) {
        pdfFile = candidateFile;
        break;
      }
    }

    if (!pdfFile) {
      return NextResponse.json(
        { error: "Firebase Storage에서 PDF를 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    const [pdfBuffer] = await pdfFile.download();
    const originalName = String(patent.pdf_original_name ?? `${patentId}.pdf`)
      .replace(/["\r\n]/g, "")
      .trim();

    const pdfBody = Uint8Array.from(pdfBuffer);
    return new NextResponse(pdfBody, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${originalName}"`,
        "Content-Length": String(pdfBuffer.length),
        "Cache-Control": "public, max-age=300",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (caught) {
    console.error("Firebase PDF view failed:", caught);
    return NextResponse.json(
      { error: "PDF 파일을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
