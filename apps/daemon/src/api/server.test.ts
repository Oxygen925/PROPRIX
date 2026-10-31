import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_COOKIE } from "@proprix/shared";
import { MemorySecretStore } from "../auth/secret-store";
import { type DaemonConfig, loadConfig } from "../config";
import { Guard, SESSION_TTL_MS, sessionCookie } from "./security";
import { type DaemonServer, serveStatic, startServer } from "./server";

const TOKEN = "test-token-0123456789";
const DEV_ORIGIN = "http://127.0.0.1:5173";

let api: DaemonServer;
let webDir: string;

beforeAll(() => {
  webDir = mkdtempSync(join(tmpdir(), "proprix-web-"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>spa</title>");
  writeFileSync(join(webDir, "app.js"), "console.log(1)");
  const config: DaemonConfig = {
    ...loadConfig({}),
    port: 0,
    apiToken: TOKEN,
    webDir,
    extraOrigins: [DEV_ORIGIN],
  };
  api = startServer(config);
});

afterAll(async () => {
  await api.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const bearer = { authorization: `Bearer ${TOKEN}` };

describe("Host·Origin 검사", () => {
  test("health 는 인증 없이 응답", async () => {
    const res = await fetch(`${api.url}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: "proprix" });
  });

  test("다른 Host 는 거부 (DNS rebinding)", async () => {
    const res = await fetch(`${api.url}/api/health`, { headers: { host: "evil.example:80" } });
    expect(res.status).toBe(421);
  });

  test("허용되지 않은 Origin 은 bearer 가 있어도 거부", async () => {
    const res = await fetch(`${api.url}/api/session`, { headers: { ...bearer, origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  test("Origin: null 은 거부", async () => {
    const res = await fetch(`${api.url}/api/session`, { headers: { ...bearer, origin: "null" } });
    expect(res.status).toBe(403);
  });

  test("허용 목록의 Origin 은 통과", async () => {
    const res = await fetch(`${api.url}/api/session`, { headers: { ...bearer, origin: DEV_ORIGIN } });
    expect(res.status).toBe(200);
  });
});

describe("인증", () => {
  test("token 없으면 401", async () => {
    const res = await fetch(`${api.url}/api/session`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  test("틀린 token 은 401", async () => {
    const res = await fetch(`${api.url}/api/session`, { headers: { authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
  });

  test("bearer 로 세션 조회", async () => {
    const res = await fetch(`${api.url}/api/session`, { headers: bearer });
    expect(await res.json()).toEqual({ authenticated: true, via: "bearer" });
  });

  test("부트스트랩 코드 → HttpOnly·SameSite=Strict 쿠키 → 쿠키 인증, 코드는 1회용", async () => {
    const code = api.guard.issueBootstrapCode();
    const res = await fetch(`${api.url}/auth/bootstrap?code=${code}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const sid = setCookie.split(";")[0];

    const session = await fetch(`${api.url}/api/session`, { headers: { cookie: sid ?? "" } });
    expect(await session.json()).toEqual({ authenticated: true, via: "cookie" });

    const again = await fetch(`${api.url}/auth/bootstrap?code=${code}`, { redirect: "manual" });
    expect(again.status).toBe(401);
  });

  test("세션은 저장소에 해시로만 남고 다시 켜도 유지, 30일 뒤 만료, 쿠키에 Max-Age", () => {
    const store = new MemorySecretStore();
    let t = 1000;
    const clock = () => t;
    const g = new Guard("token", 1, [], clock, store);
    const sid = g.redeemBootstrapCode(g.issueBootstrapCode()) ?? "";
    expect(store.value).not.toContain(sid);
    const req = (s: string) => new Request("http://127.0.0.1:1/", { headers: { cookie: `${SESSION_COOKIE}=${s}` } });
    const restarted = new Guard("token", 1, [], clock, store);
    expect(restarted.authenticate(req(sid))).toBe("cookie");
    expect(restarted.authenticate(req("forged"))).toBeNull();
    expect(sessionCookie(sid)).toContain("Max-Age=2592000");
    t += SESSION_TTL_MS + 1;
    expect(restarted.authenticate(req(sid))).toBeNull();
    expect(new Guard("token", 1, [], clock, store).authenticate(req(sid))).toBeNull();
    // 저장소를 못 읽어도 시작은 된다
    store.value = "not json";
    expect(new Guard("token", 1, [], clock, store).authenticate(req(sid))).toBeNull();
  });

  test("위조한 세션 쿠키는 401", async () => {
    const res = await fetch(`${api.url}/api/session`, { headers: { cookie: `${SESSION_COOKIE}=forged` } });
    expect(res.status).toBe(401);
  });

  test("인증된 미지정 API 는 404", async () => {
    const res = await fetch(`${api.url}/api/nope`, { headers: bearer });
    expect(res.status).toBe(404);
  });
});

describe("WebSocket", () => {
  test("인증 없이 upgrade 불가", async () => {
    const res = await fetch(`${api.url}/api/ws`, { headers: { upgrade: "websocket", connection: "Upgrade" } });
    expect(res.status).toBe(401);
  });

  test("hello → ping/pong", async () => {
    const ws = new WebSocket(`${api.url.replace("http", "ws")}/api/ws`, { headers: bearer } as never);
    const messages: unknown[] = [];
    await new Promise<void>((done, fail) => {
      ws.onerror = () => fail(new Error("ws error"));
      ws.onmessage = (e) => {
        messages.push(JSON.parse(String(e.data)));
        if (messages.length === 1) ws.send(JSON.stringify({ type: "ping" }));
        else done();
      };
    });
    ws.close();
    expect(messages[0]).toMatchObject({ type: "hello" });
    expect(messages[1]).toMatchObject({ type: "pong" });
  });
});

describe("정적 서빙", () => {
  test("파일과 SPA fallback", async () => {
    expect(await (await fetch(`${api.url}/app.js`)).text()).toBe("console.log(1)");
    expect(await (await fetch(`${api.url}/rooms/abc`)).text()).toContain("<title>spa</title>");
  });

  // fetch 는 URL 의 ../ 를 정규화하므로 서빙 함수를 직접 호출한다
  test("webDir 밖 경로는 거부", async () => {
    const outside = mkdtempSync(join(tmpdir(), "proprix-outside-"));
    const inner = join(outside, "web");
    mkdirSync(inner);
    writeFileSync(join(outside, "secret.txt"), "secret");
    try {
      for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%5csecret.txt"]) {
        const res = await serveStatic(inner, p);
        expect(res.status).toBe(404);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("Guard", () => {
  test("부트스트랩 코드는 5분 뒤 만료", () => {
    let now = 0;
    const g = new Guard(TOKEN, 1, [], () => now);
    const code = g.issueBootstrapCode();
    now = 5 * 60_000 + 1;
    expect(g.redeemBootstrapCode(code)).toBeNull();
  });
});

describe("앱 창(다른 origin): CORS·WebSocket 토큰", () => {
  test("preflight 는 인증 없이 204, 응답(오류 포함)에 CORS 헤더", async () => {
    const pre = await fetch(`${api.url}/api/session`, {
      method: "OPTIONS",
      headers: { origin: DEV_ORIGIN, "access-control-request-headers": "authorization" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(DEV_ORIGIN);
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");

    const ok = await fetch(`${api.url}/api/session`, { headers: { ...bearer, origin: DEV_ORIGIN } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(DEV_ORIGIN);
    const denied = await fetch(`${api.url}/api/session`, { headers: { origin: DEV_ORIGIN } });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe(DEV_ORIGIN); // 오류 본문을 읽을 수 있게

    // 같은 origin·로컬 클라이언트에는 붙이지 않는다
    expect(
      (await fetch(`${api.url}/api/session`, { headers: bearer })).headers.get("access-control-allow-origin"),
    ).toBeNull();
    // 허용되지 않은 origin 의 preflight 는 Origin 검사에서 거부
    expect(
      (await fetch(`${api.url}/api/session`, { method: "OPTIONS", headers: { origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
  });

  test("WebSocket 은 ?token= 으로도 인증된다 (틀리면 401)", async () => {
    const ws = new WebSocket(`${api.url.replace("http", "ws")}/api/ws?token=${TOKEN}`, {
      headers: { origin: DEV_ORIGIN },
    } as never);
    const hello = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (e) => resolve(String(e.data));
      ws.onerror = () => reject(new Error("ws error"));
    });
    expect(JSON.parse(hello)).toMatchObject({ type: "hello" });
    ws.close();
    const bad = await fetch(`${api.url}/api/ws?token=wrong`, { headers: { origin: DEV_ORIGIN } });
    expect(bad.status).toBe(401);
  });
});
