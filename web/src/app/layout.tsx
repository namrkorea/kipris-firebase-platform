import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "KIPRIS 특허 수집·검색",
  description: "로그인 없이 이용하는 KIPRIS 공개특허 수집 및 검색 플랫폼",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        <header className="site-header">
          <div className="header-inner">
            <Link href="/" className="brand">
              KIPRIS Patent Hub
            </Link>
            <nav>
              <Link href="/patents">공개 특허</Link>
              <Link href="/request">수집 요청</Link>
              <Link href="/jobs">요청·결과</Link>
            </nav>
          </div>
        </header>
        <main className="page-shell">{children}</main>
        <footer className="site-footer">
          공개 특허정보를 수집·정리하는 검토 플랫폼
        </footer>
      </body>
    </html>
  );
}
