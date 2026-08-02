import Link from "next/link";

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <h1>KIPRIS Patent Hub</h1>
        <p>
          로그인 없이 공개 특허를 검색하고 새로운 KIPRIS 수집 작업을 요청할
          수 있습니다. 실제 KIPRIS 호출·XML 분석·PDF 저장은 별도로 분리된
          Python Worker가 안전하게 처리합니다.
        </p>
        <div className="actions">
          <Link className="button secondary" href="/patents">
            공개 특허 검색
          </Link>
          <Link className="button" href="/request">
            신규 수집 요청
          </Link>
        </div>
      </section>

      <section className="grid">
        <article className="card">
          <h2>로그인 없는 공개 이용</h2>
          <p>
            검색과 수집 요청에 계정이 필요하지 않습니다. 작업 확인용 비밀
            토큰은 사용자의 브라우저에만 저장됩니다.
          </p>
        </article>
        <article className="card">
          <h2>안전한 작업 대기열</h2>
          <p>
            요청은 Vercel 서버에서 검증되고 Supabase 대기열에 저장됩니다.
            익명 사용자의 직접 데이터베이스 쓰기는 차단됩니다.
          </p>
        </article>
        <article className="card">
          <h2>Python Worker</h2>
          <p>
            KIPRIS 검색, XML 분석, PDF 다운로드 및 Supabase 저장을 순서대로
            수행합니다.
          </p>
        </article>
      </section>
    </>
  );
}
