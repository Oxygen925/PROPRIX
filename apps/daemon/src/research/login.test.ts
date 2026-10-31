// 사이트 자동 로그인 통합 (P12c): Chromium 이 있을 때만 (PROPRIX_TEST_BROWSER=headless shell 실행 파일 경로).
// 로컬 시험 사이트와 시험용 계정만 쓴다
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Agent, AgentInput } from "@proprix/shared";
import { AgentStore, DEFAULT_PERSONA_ID } from "../agents/store";
import { FileSecretStore } from "../auth/secret-store";
import { migrate } from "../storage/db";
import { SiteAccountStore } from "./accounts";
import { PageReader } from "./browser";
import { RobotsCache } from "./robots";

const exe = process.env.PROPRIX_TEST_BROWSER ?? "";
const tmp = mkdtempSync(join(tmpdir(), "proprix-login-test-"));

const USER = "tester";
const PASSWORD = "test-pass-only";
const posts: string[] = [];
const html = (title: string, body: string, headers: Record<string, string> = {}) =>
  new Response(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
const secret = `<article><h1>회원 글</h1>${"<p>회원 전용 본문입니다. 충분히 길게 적어 둔 내용입니다.</p>".repeat(10)}<a href="/logout">로그아웃</a></article>`;
const form = (action: string) =>
  `<form method="post" action="${action}"><input name="id" type="text"><input name="pw" type="password"><button type="submit">로그인</button></form>`;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const cookie = req.headers.get("cookie") ?? "";
    if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /secret\n");
    if (req.method === "POST") posts.push(`${path} ${await req.text()}`);
    if (path === "/members")
      return cookie.includes("sid=ok") ? html("회원", secret) : Response.redirect(`${url.origin}/login`, 302);
    if (path === "/secret") return html("비공개", "<p>x</p>");
    if (path === "/login") {
      if (req.method === "GET") return html("로그인", form("/login"));
      const ok = posts.at(-1)?.includes(`pw=${PASSWORD}`);
      return ok
        ? new Response(null, { status: 302, headers: { location: "/members", "set-cookie": "sid=ok; Path=/" } })
        : html("로그인", `<p>틀렸습니다</p>${form("/login")}`);
    }
    if (path === "/otp-login") {
      if (req.method === "GET") return html("로그인", form("/otp-login"));
      return html("인증", '<p>인증번호를 입력하세요</p><form><input name="code" autocomplete="one-time-code"></form>');
    }
    if (path === "/evil-login") return html("로그인", form(`http://localhost:${url.port}/steal`));
    if (path === "/stepped") {
      if (req.method === "GET")
        return html(
          "로그인",
          '<form method="post" action="/stepped"><input name="username" type="text"><button>다음</button></form>',
        );
      return posts.at(-1)?.includes("username=") ? html("로그인", form("/login")) : html("x", "x");
    }
    if (path === "/logout") return html("로그아웃", "<p>로그아웃됨</p>");
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;

const db = new Database(":memory:", { strict: true });
migrate(db);
const agents = new AgentStore(db);
const make = (name: string) => agents.createAgent(AgentInput.parse({ personaId: DEFAULT_PERSONA_ID, name })) as Agent;
const A = make("갑");
const B = make("을");
const accounts = new SiteAccountStore(db, join(tmp, "site"), () => {}, {
  allowHttp: true,
  open: (p) => new FileSecretStore(p),
});
const newReader = () =>
  new PageReader({
    exePath: () => exe || null,
    profileRoot: tmp,
    denyDomains: () => [],
    accounts,
    allowPrivate: true,
    delayMs: 0,
    loginWaitMs: 1500,
    robots: new RobotsCache(),
  });
const reader = newReader();
const register = (agentId: string, loginPath: string, password = PASSWORD) => {
  const a = accounts.create(agentId, {
    domain: "127.0.0.1",
    loginUrl: `${base}${loginPath}`,
    username: USER,
    password,
  });
  if ("error" in a) throw new Error(a.message);
  return a;
};

afterAll(async () => {
  await reader.close();
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

test.skipIf(!exe)(
  "로그인 → 회원 페이지, 에이전트끼리 쿠키 분리, 세션 복원, 로그아웃 주소는 안 읽음, 로그에 비밀번호 없음",
  async () => {
    const a = register(A.id, "/login");
    const logs: string[] = [];
    const ctx = { agentId: A.id, runKey: "run1", onLogin: (t: string) => logs.push(t) };
    const r = await reader.read(`${base}/members`, undefined, ctx);
    expect(r).toMatchObject({ status: "ok", session: true });
    expect(r.text).toContain("회원 전용 본문");
    expect(posts.at(-1)).toContain(`id=${USER}`);
    expect(logs.join()).toContain("로그인 성공");
    expect(logs.join()).not.toContain(PASSWORD);
    expect(accounts.get(a.id)).toMatchObject({ status: "ok", hasSession: true });
    expect(JSON.stringify(r)).not.toContain(PASSWORD);

    // 다시 읽어도 로그인하지 않는다
    const count = posts.length;
    expect((await reader.read(`${base}/members`, undefined, ctx)).status).toBe("ok");
    expect(posts.length).toBe(count);

    // 계정 없는 에이전트 B 와 맥락 없는 읽기에는 A 의 쿠키가 없다
    const other = await reader.read(`${base}/members`, undefined, { agentId: B.id, runKey: "run2" });
    expect(other.session).toBeUndefined();
    expect(other.text).not.toContain("회원 전용 본문");
    expect((await reader.read(`${base}/members`)).text).not.toContain("회원 전용 본문");

    // 브라우저를 새로 띄워도 저장한 세션으로 읽는다
    const fresh = newReader();
    const again = await fresh.read(`${base}/members`, undefined, { agentId: A.id, runKey: "run3" });
    expect(again.text).toContain("회원 전용 본문");
    expect(posts.length).toBe(count);
    await fresh.close();

    // 로그아웃 주소는 로그인 세션으로 읽지 않는다. robots 도 그대로
    expect((await reader.read(`${base}/logout`, undefined, ctx)).reason).toBe("unsafe_link");
    expect((await reader.read(`${base}/secret`, undefined, ctx)).status).toBe("robots");
    // 계정을 지우면 메모리의 로그인 상태도 버린다
    accounts.delete(a.id);
    await reader.forgetAgent(A.id);
    expect((await reader.read(`${base}/members`, undefined, ctx)).text).not.toContain("회원 전용 본문");
  },
  60_000,
);

test.skipIf(!exe)(
  "틀린 비밀번호는 실행당 한 번만, 2단계 인증은 멈춤, 다른 호스트로 제출하는 폼에는 입력하지 않음, 아이디 먼저 받는 폼",
  async () => {
    const wrong = register(A.id, "/login", "wrong-pass");
    const before = posts.length;
    const ctx = { agentId: A.id, runKey: "w1" };
    const r = await reader.read(`${base}/members`, undefined, ctx);
    expect(r).toMatchObject({ status: "blocked", reason: "login_required" });
    expect(accounts.get(wrong.id)?.lastError).toBe("wrong_credentials");
    await reader.read(`${base}/members`, undefined, ctx);
    expect(posts.length).toBe(before + 1);
    accounts.delete(wrong.id);
    await reader.forgetAgent(A.id);

    const otp = register(A.id, "/otp-login");
    expect(await reader.testLogin(otp)).toBe("two_factor");
    expect(accounts.get(otp.id)?.status).toBe("needs_attention");
    accounts.delete(otp.id);
    await reader.forgetAgent(A.id);

    const evil = register(A.id, "/evil-login");
    const n = posts.length;
    expect(await reader.testLogin(evil)).toBe("redirect_host");
    expect(posts.length).toBe(n); // 아무것도 보내지 않음
    accounts.delete(evil.id);
    await reader.forgetAgent(A.id);

    const stepped = register(A.id, "/stepped");
    expect(await reader.testLogin(stepped)).toBe("ok");
    accounts.delete(stepped.id);
    await reader.forgetAgent(A.id);
  },
  60_000,
);
