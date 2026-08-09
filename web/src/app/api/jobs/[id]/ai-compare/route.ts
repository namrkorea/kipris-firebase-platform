import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "../../../../../lib/firebase-admin";

export const runtime = "nodejs";
export const maxDuration = 60;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PATENT_ID_PATTERN =
  /^[0-9a-f]{40}$/i;

const MAX_COMPARE_PATENTS = 10;

function serverConfig() {
  const openaiApiKey =
    process.env.OPENAI_API_KEY?.trim();

  if (!openaiApiKey) {
    throw new Error(
      "OPENAI_API_KEY가 설정되지 않았습니다.",
    );
  }

  return { openaiApiKey };
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return String(value);
}

function extractResponseText(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const response =
    value as Record<string, unknown>;

  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  if (!Array.isArray(response.output)) {
    return "";
  }

  for (const item of response.output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const content =
      (item as Record<string, unknown>).content;

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }

      const record =
        part as Record<string, unknown>;

      if (
        record.type === "output_text" &&
        typeof record.text === "string"
      ) {
        return record.text;
      }
    }
  }

  return "";
}

const comparisonSchema = {
  type: "object",
  additionalProperties: false,

  properties: {
    overall_summary: {
      type: "string",
    },

    common_technologies: {
      type: "array",
      items: {
        type: "string",
      },
    },

    key_differences: {
      type: "array",
      items: {
        type: "string",
      },
    },

    items: {
      type: "array",

      items: {
        type: "object",
        additionalProperties: false,

        properties: {
          patent_id: {
            type: "string",
          },

          title: {
            type: "string",
          },

          applicant: {
            type: "string",
          },

          core_technology: {
            type: "string",
          },

          distinguishing_point: {
            type: "string",
          },

          group_similarity_score: {
            type: "integer",
            minimum: 0,
            maximum: 100,
          },
        },

        required: [
          "patent_id",
          "title",
          "applicant",
          "core_technology",
          "distinguishing_point",
          "group_similarity_score",
        ],
      },
    },

    similar_pairs: {
      type: "array",

      items: {
        type: "object",
        additionalProperties: false,

        properties: {
          left_patent_id: {
            type: "string",
          },

          right_patent_id: {
            type: "string",
          },

          similarity_score: {
            type: "integer",
            minimum: 0,
            maximum: 100,
          },

          reason: {
            type: "string",
          },
        },

        required: [
          "left_patent_id",
          "right_patent_id",
          "similarity_score",
          "reason",
        ],
      },
    },

    review_notes: {
      type: "array",
      items: {
        type: "string",
      },
    },

    limitations: {
      type: "string",
    },
  },

  required: [
    "overall_summary",
    "common_technologies",
    "key_differences",
    "items",
    "similar_pairs",
    "review_notes",
    "limitations",
  ],
} as const;

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{
      id: string;
    }>;
  },
) {
  try {
    const { id } = await context.params;

    const body = (await request.json()) as {
      token?: unknown;
      patentIds?: unknown;
    };

    const token =
      typeof body.token === "string"
        ? body.token.trim()
        : "";

    const patentIds =
      Array.isArray(body.patentIds)
        ? Array.from(
            new Set(
              body.patentIds.filter(
                (value): value is string =>
                  typeof value === "string" &&
                  PATENT_ID_PATTERN.test(value),
              ),
            ),
          )
        : [];

    if (
      !UUID_PATTERN.test(id) ||
      !UUID_PATTERN.test(token)
    ) {
      return NextResponse.json(
        {
          error:
            "작업 확인 정보가 올바르지 않습니다.",
        },
        {
          status: 400,
        },
      );
    }

    if (
      patentIds.length < 2 ||
      patentIds.length > MAX_COMPARE_PATENTS
    ) {
      return NextResponse.json(
        {
          error:
            "AI 비교는 특허 2~10건을 선택해 주세요.",
        },
        {
          status: 400,
        },
      );
    }

    const { openaiApiKey } =
      serverConfig();

    // ------------------------------------------------
    // 1. Firestore에서 작업 확인
    // ------------------------------------------------

    const jobRef = adminDb
      .collection("collection_jobs")
      .doc(id);

    const jobSnapshot =
      await jobRef.get();

    if (!jobSnapshot.exists) {
      return NextResponse.json(
        {
          error:
            "작업을 찾을 수 없습니다.",
        },
        {
          status: 404,
        },
      );
    }

    const job =
      jobSnapshot.data() ?? {};

    if (
      String(job.public_token ?? "") !==
      token
    ) {
      return NextResponse.json(
        {
          error:
            "작업을 찾을 수 없습니다.",
        },
        {
          status: 404,
        },
      );
    }

    // ------------------------------------------------
    // 2. 선택한 특허가 해당 작업 results에
    //    실제 포함되어 있는지 확인
    // ------------------------------------------------

    const patents: Array<
      Record<string, unknown>
    > = [];

    for (
      let index = 0;
      index < patentIds.length;
      index += 1
    ) {
      const patentId =
        patentIds[index];

      const resultSnapshot =
        await jobRef
          .collection("results")
          .doc(patentId)
          .get();

      if (!resultSnapshot.exists) {
        return NextResponse.json(
          {
            error:
              "선택한 특허 중 이 작업에 속하지 않는 항목이 있습니다.",
          },
          {
            status: 400,
          },
        );
      }

      // ----------------------------------------------
      // 3. patents/{patentId} 실제 특허정보 조회
      // ----------------------------------------------

      const patentSnapshot =
        await adminDb
          .collection("patents")
          .doc(patentId)
          .get();

      if (!patentSnapshot.exists) {
        return NextResponse.json(
          {
            error:
              "선택한 특허 정보를 찾을 수 없습니다.",
          },
          {
            status: 400,
          },
        );
      }

      const patent =
        patentSnapshot.data() ?? {};

      patents.push({
        display_order:
          index + 1,

        patent_id:
          patentId,

        application_number:
          textValue(
            patent.application_number,
          ),

        invention_title:
          textValue(
            patent.invention_title,
          ),

        applicant_name:
          textValue(
            patent.applicant_name,
          ),

        ipc_number:
          textValue(
            patent.ipc_number,
          ),

        application_date:
          textValue(
            patent.application_date,
          ),

        publication_number:
          textValue(
            patent.publication_number ??
              patent.open_number,
          ),

        publication_date:
          textValue(
            patent.publication_date ??
              patent.open_date,
          ),

        register_number:
          textValue(
            patent.register_number,
          ),

        register_date:
          textValue(
            patent.register_date,
          ),

        register_status:
          textValue(
            patent.register_status,
          ),

        abstract:
          textValue(
            patent.abstract,
          ),
      });
    }

    // ------------------------------------------------
    // 4. OpenAI 비교 분석
    // ------------------------------------------------

    const instructions = [
      "당신은 특허 기술 비교를 돕는 분석 보조자입니다.",
      "반드시 제공된 서지정보, IPC, 초록만 근거로 한국어로 분석하세요.",
      "청구항 원문이 제공되지 않았으므로 침해, 무효, 권리범위에 대한 법률적 결론을 내리지 마세요.",
      "유사도 점수는 초록의 기술 내용과 IPC의 근접성을 바탕으로 한 예비 기술 유사도이며 법률적 유사도 점수가 아닙니다.",
      "각 특허의 핵심 기술과 차별점을 구체적으로 적고, 서로 유사도가 높은 조합을 우선 제시하세요.",
      "근거가 부족한 내용은 추정하지 말고 한계에 명시하세요.",
    ].join("\n");

    const openaiResponse =
      await fetch(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${openaiApiKey}`,

            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            model: "gpt-5-mini",

            store: false,

            instructions,

            input: JSON.stringify(
              {
                task:
                  "선택 특허 기술 비교",

                search_query:
                  job.query_text ?? "",

                report_title:
                  job.report_title ?? "",

                review_purpose:
                  job.review_purpose ?? "",

                patents,
              },
              null,
              2,
            ),

            max_output_tokens:
              5000,

            text: {
              format: {
                type:
                  "json_schema",

                name:
                  "patent_comparison",

                strict:
                  true,

                schema:
                  comparisonSchema,
              },
            },
          }),

          signal:
            AbortSignal.timeout(
              55_000,
            ),
        },
      );

    if (!openaiResponse.ok) {
      const errorText =
        await openaiResponse.text();

      console.error(
        "OpenAI patent comparison failed:",
        openaiResponse.status,
        errorText.slice(0, 1000),
      );

      return NextResponse.json(
        {
          error:
            "GPT-5 mini 분석 요청에 실패했습니다.",
        },
        {
          status: 502,
        },
      );
    }

    const openaiData =
      (await openaiResponse.json()) as unknown;

    const responseText =
      extractResponseText(
        openaiData,
      );

    if (!responseText) {
      return NextResponse.json(
        {
          error:
            "GPT-5 mini가 비교 결과를 반환하지 않았습니다.",
        },
        {
          status: 502,
        },
      );
    }

    let comparison: unknown;

    try {
      comparison =
        JSON.parse(responseText);
    } catch {
      console.error(
        "OpenAI comparison JSON parse failed.",
      );

      return NextResponse.json(
        {
          error:
            "GPT-5 mini 비교 결과 형식을 읽지 못했습니다.",
        },
        {
          status: 502,
        },
      );
    }

    return NextResponse.json(
      {
        model:
          "gpt-5-mini",

        compared_count:
          patents.length,

        comparison,
      },

      {
        headers: {
          "Cache-Control":
            "no-store",
        },
      },
    );
  } catch (caught) {
    console.error(
      "AI patent comparison failed:",
      caught,
    );

    return NextResponse.json(
      {
        error:
          "AI 비교 서버 처리 중 오류가 발생했습니다.",
      },
      {
        status: 500,
      },
    );
  }
}