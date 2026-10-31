// 리서치 페이지 읽기 통합 (P11a): Chromium 이 있을 때만 (PROPRIX_TEST_BROWSER=headless shell 실행 파일 경로)
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PageReader } from "./browser";
import { RobotsCache } from "./robots";

const exe = process.env.PROPRIX_TEST_BROWSER ?? "";
const profileRoot = mkdtempSync(join(tmpdir(), "proprix-browser-test-"));

const html = (body: string) =>
  new Response(`<!doctype html><html><head><title>시험</title></head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
const article = Array.from(
  { length: 6 },
  (_, i) => `<p>문단 ${i + 1}: ${"리서치 본문 내용을 길게 적는다. ".repeat(8)}</p>`,
).join("");
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /secret\n");
    if (path === "/article")
      return html(`<nav>메뉴</nav><article><h1>제목</h1>${article}<p><a href="/next">다음 글</a></p></article>`);
    if (path === "/js")
      return html(
        `<div id="app"></div><script>document.getElementById('app').innerHTML='<h2>JS 로 그린 글</h2><p>${"스크립트가 만든 본문. ".repeat(20)}</p>'</script>`,
      );
    if (path === "/captcha")
      return new Response("<html><body>Please verify you are human</body></html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      });
    if (path === "/secret") return html("<p>비밀</p>");
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
const reader = new PageReader({
  exePath: () => exe || null,
  profileRoot,
  denyDomains: () => ["blocked.test"],
  allowPrivate: true,
  delayMs: 0,
  robots: new RobotsCache(),
});

afterAll(async () => {
  await reader.close();
  server.stop();
  rmSync(profileRoot, { recursive: true, force: true });
});

test.skipIf(!exe)(
  "본문·링크 추출, JS 렌더링, robots·CAPTCHA·차단 도메인",
  async () => {
    const a = await reader.read(`${base}/article`);
    expect(a.status).toBe("ok");
    expect(a.title).toBe("시험"); // Readability 는 <title> 을 쓴다
    expect(a.text).toContain("문단 1");
    expect(a.text).not.toContain("메뉴");
    expect(a.links.map((l) => l.url)).toContain(`${base}/next`);

    const js = await reader.read(`${base}/js`);
    expect(js.status).toBe("ok");
    expect(js.text).toContain("스크립트가 만든 본문");

    expect((await reader.read(`${base}/secret`)).status).toBe("robots");
    expect((await reader.read(`${base}/captcha`)).status).toBe("blocked");
    expect((await reader.read("https://news.blocked.test/")).status).toBe("denied");
    expect((await reader.read("file:///C:/Windows/win.ini")).status).toBe("denied");
  },
  60_000,
);
