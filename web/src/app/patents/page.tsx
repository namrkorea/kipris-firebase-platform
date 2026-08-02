"use client";

import { FormEvent, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

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

export default function PatentsPage() {
  const [query, setQuery] = useState("");
  const [patents, setPatents] = useState<Patent[]>([]);
  const [message, setMessage] = useState("최근 공개 특허를 불러오는 중...");

  async function search(searchText = "") {
    setMessage("검색 중...");

    let request = supabase
      .from("patents")
      .select(
        "id,application_number,invention_title,applicant_name,ipc_number,application_date,abstract,register_status",
      )
      .eq("is_public", true)
      .order("created_at", { ascending: false })
      .limit(50);

    const normalized = searchText.trim();
    if (normalized) {
      const safe = normalized.replace(/[,%()]/g, " ");
      request = request.or(
        `invention_title.ilike.%${safe}%,applicant_name.ilike.%${safe}%,ipc_number.ilike.%${safe}%,application_number.ilike.%${safe}%`,
      );
    }

    const { data, error } = await request;
    if (error) {
      setMessage("검색 결과를 불러오지 못했습니다.");
      setPatents([]);
      return;
    }

    setPatents(data ?? []);
    setMessage((data?.length ?? 0) === 0 ? "검색 결과가 없습니다." : "");
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
