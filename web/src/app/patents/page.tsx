"use client";

import { FormEvent, useEffect, useState } from "react";

type Patent = {
  id: string;
  application_number: string;
  invention_title: string | null;
  applicant_name: string | null;
  ipc_number: string | null;
  application_date: string | null;
  abstract: string | null;
  register_status: string | null;
};

type SearchResponse = {
  data?: Patent[];
  error?: string;
};

export default function PatentsPage() {
  const [query, setQuery] = useState("");
  const [patents, setPatents] = useState<Patent[]>([]);
  const [message, setMessage] = useState("최근 공개 특허를 불러오는 중...");

  async function search(searchText = "") {
    setMessage("검색 중...");

    try {
      const params = new URLSearchParams({
        q: searchText.trim(),
        limit: "50",
      });
      const response = await fetch(`/api/patents?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as SearchResponse;

      if (!response.ok) {
        throw new Error(payload.error || "검색 요청에 실패했습니다.");
      }

      const rows = payload.data ?? [];
      setPatents(rows);
      setMessage(rows.length === 0 ? "검색 결과가 없습니다." : "");
    } catch (caught) {
      console.error("Public patent search failed:", caught);
      setMessage("검색 결과를 불러오지 못했습니다.");
      setPatents([]);
    }
  }

  useEffect(() => {
    search();
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    search(query);
  }

  return (
    <section>
      <h1>공개 특허 검색</h1>
      <form className="card" onSubmit={submit}>
        <label htmlFor="patentQuery">제목·출원인·IPC·출원번호</label>
        <input
          id="patentQuery"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={100}
          placeholder="저장된 공개 특허에서 검색"
        />
        <div className="actions">
          <button type="submit">검색</button>
        </div>
      </form>

      {message && <p className="notice">{message}</p>}

      <div className="list" style={{ marginTop: 18 }}>
        {patents.map((patent) => (
          <article key={patent.id} className="list-item">
            <div className="meta">
              <span>{patent.application_number}</span>
              <span>{patent.application_date ?? "-"}</span>
              <span>{patent.ipc_number ?? "-"}</span>
              <span>{patent.register_status ?? "-"}</span>
            </div>
            <h3>{patent.invention_title || "제목 없음"}</h3>
            <p>{patent.applicant_name || "출원인 정보 없음"}</p>
            {patent.abstract && (
              <p>
                {patent.abstract.length > 300
                  ? `${patent.abstract.slice(0, 300)}…`
                  : patent.abstract}
              </p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
