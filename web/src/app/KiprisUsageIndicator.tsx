"use client";

import { useEffect, useState } from "react";

type Usage = {
  period: string;
  count: number;
  limit: number;
  remaining: number;
  percent: number;
  limitExceeded: boolean;
  trackingBasis: string;
};

export default function KiprisUsageIndicator() {
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadUsage() {
      try {
        const response = await fetch("/api/kipris-usage", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as Usage;
        if (!cancelled) setUsage(data);
      } catch {
        // 사용량 표시는 보조 정보이므로 실패해도 본 서비스 이용을 막지 않습니다.
      }
    }

    void loadUsage();
    const timer = window.setInterval(loadUsage, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!usage) return null;

  const month = Number(usage.period.slice(5, 7));
  const warning = usage.limitExceeded || usage.percent >= 80;

  return (
    <div
      title={`${usage.trackingBasis}. 기존 공식 사용량과 차이가 있을 수 있습니다.`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "7px 10px",
        borderRadius: "10px",
        border: warning ? "1px solid #dc8c8c" : "1px solid rgba(255,255,255,0.22)",
        background: warning ? "#fff0f0" : "rgba(255,255,255,0.08)",
        color: warning ? "#9f2525" : "#f5f7fb",
        fontSize: "12px",
        lineHeight: 1.25,
        whiteSpace: "nowrap",
      }}
    >
      <strong>KIPRIS API</strong>
      <span>
        {usage.limitExceeded
          ? `한도 초과 감지 · ${month}월 기록 ${usage.count}/${usage.limit}회`
          : `${month}월 예상 사용량 ${usage.count}/${usage.limit}회`}
      </span>
    </div>
  );
}
