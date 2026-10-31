// SIWC 계정 시나리오 (모의 서버). desktop_pet P3 시나리오(로그인·스트림·오류·갱신·로그아웃)에 대응
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MockSiwc, startMockSiwc } from "@proprix/mock-siwc";
import type { SignInResult } from "@proprix/shared";
import { type AiRequest, endpointsForBase } from "@proprix/siwc";
import { SiwcAccount } from "./account";
import { MemorySecretStore } from "./secret-store";

let mock: MockSiwc;
let dir: string;

beforeAll(async () => {
  mock = await startMockSiwc();
  dir = mkdtempSync(join(tmpdir(), "proprix-auth-"));
});
afterAll(async () => {
  await mock.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => mock.reset());

function makeAccount(store = new MemorySecretStore()) {
  return new SiwcAccount({
    endpoints: endpointsForBase(mock.url),
    authDir: dir,
    callbackPort: 0,
    retryBaseMs: 1,
    store,
  });
}

// 브라우저 흉내: 인가 URL → 302 → loopback 콜백
async function signIn(account: SiwcAccount): Promise<SignInResult> {
  const attempt = await account.beginSignIn();
  if ("ok" in attempt) return attempt;
  const res = await fetch(attempt.authorizeUrl, { redirect: "manual" });
  const location = res.headers.get("location");
  if (location) await fetch(location);
  return attempt.result;
}

const req = (text = "hi"): AiRequest => ({ model: "mock-chat", instructions: "test", turns: [{ role: "user", text }] });

async function collect(account: SiwcAccount, r = req(), signal?: AbortSignal) {
  let text = "";
  const result = await account.stream(r, { signal, onDelta: (d) => (text += d) });
  return { ...result, text };
}

describe("로그인", () => {
  test("최초 등록 → 스트림 → 모델 목록", async () => {
    const a = makeAccount();
    expect(a.info()).toMatchObject({ registered: false, signedIn: false, mock: true });
    expect(await signIn(a)).toEqual({ ok: true, code: "ok" });
    expect(mock.stats.lastAuthorize).toMatchObject({ client_id: "dynamic_agent_client", agent_name_hint: "PROPRIX" });
    expect(a.info()).toMatchObject({ registered: true, signedIn: true, planUsage: true, email: "tester@example.test" });

    const r = await collect(a, req("안녕"));
    expect(r).toMatchObject({ outcome: "completed", attempts: 1, text: "echo: 안녕" });
    expect(mock.stats.lastResponsesBody).toMatchObject({ store: false, stream: true, instructions: "test" });

    const { result, models } = await a.listModels();
    expect(result.ok).toBe(true);
    expect(models).toEqual([{ slug: "mock-chat", displayName: "Mock Chat", efforts: [] }]);
  });

  test("저장한 자격 증명으로 재시작 → 다시 로그인은 발급 client_id + 힌트", async () => {
    const store = new MemorySecretStore();
    await signIn(makeAccount(store));
    const restarted = makeAccount(store);
    expect(restarted.info().signedIn).toBe(true);
    expect((await collect(restarted)).outcome).toBe("completed");

    expect((await signIn(restarted)).ok).toBe(true);
    expect(mock.stats.lastAuthorize).toMatchObject({ id_token_hint: true, login_hint: true, agent_name_hint: "" });
    expect(String(mock.stats.lastAuthorize?.client_id)).toStartWith("oaiapp_mock");
  });

  test("로그아웃 → revoke, 다시 로그인에는 id_token_hint 없음", async () => {
    const a = makeAccount();
    await signIn(a);
    expect(await a.signOut(false)).toEqual({ ok: true, code: "" });
    expect(mock.stats.counts.revoke).toBe(1);
    expect(a.info()).toMatchObject({ registered: true, signedIn: false });
    expect((await collect(a)).recovery).toBe("re_sign_in");
    await signIn(a);
    expect(mock.stats.lastAuthorize).toMatchObject({ id_token_hint: false, login_hint: true });
  });

  test("revoke 실패: 유지, forceLocal 이면 미확인으로 로컬 삭제", async () => {
    const a = makeAccount();
    await signIn(a);
    mock.setModes({ revoke: "fail" });
    expect(await a.signOut(false)).toEqual({ ok: false, code: "revoke_failed" });
    expect(mock.stats.counts.revoke).toBe(2); // 5xx 1회 재시도
    expect(a.info().signedIn).toBe(true);
    expect(await a.signOut(true)).toEqual({ ok: true, code: "revoke_unconfirmed" });
    expect(a.info().signedIn).toBe(false);
  });

  test("거부·state 불일치·plan 범위 없음", async () => {
    mock.setModes({ auth: "deny" });
    expect(await signIn(makeAccount())).toEqual({ ok: false, code: "access_denied" });

    // 틀린 state 콜백은 400 으로 무시하고 계속 기다린다 → 취소로 끝냄
    mock.setModes({ auth: "badstate" });
    const a = makeAccount();
    const attempt = await a.beginSignIn();
    if ("ok" in attempt) throw new Error("listener");
    const loc = (await fetch(attempt.authorizeUrl, { redirect: "manual" })).headers.get("location") ?? "";
    expect((await fetch(loc)).status).toBe(400);
    a.cancelSignIn();
    expect(await attempt.result).toEqual({ ok: false, code: "cancelled" });

    mock.setModes({ auth: "noplan" });
    const n = makeAccount();
    expect((await signIn(n)).ok).toBe(true);
    expect(n.info()).toMatchObject({ signedIn: true, planUsage: false });
    expect(await collect(n)).toMatchObject({
      outcome: "failed",
      code: "plan_usage_disabled",
      recovery: "not_eligible",
    });
  });

  test("최초 등록은 지정 포트가 사용 중이면 실패", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    try {
      const a = new SiwcAccount({
        endpoints: endpointsForBase(mock.url),
        authDir: dir,
        callbackPort: blocker.port,
        store: new MemorySecretStore(),
      });
      expect(await a.beginSignIn()).toEqual({ ok: false, code: "port_in_use" });
    } finally {
      await blocker.stop(true);
    }
  });
});

describe("스트림 오류", () => {
  let a: SiwcAccount;
  beforeEach(async () => {
    a = makeAccount();
    await signIn(a);
  });

  test("스트림 도중 사용량 한도 (response.failed)", async () => {
    mock.setModes({ responses: "usage_limit" });
    const r = await collect(a);
    expect(r).toMatchObject({
      outcome: "failed",
      code: "subscription_sharing_usage_limit_exceeded",
      recovery: "usage_limit",
      attempts: 1,
    });
    expect(r.chars).toBeGreaterThan(0);
  });

  test("429 는 재시도하지 않음", async () => {
    mock.setModes({ responses: "usage_limit_http" });
    expect(await collect(a)).toMatchObject({ outcome: "failed", recovery: "usage_limit", http: 429, attempts: 1 });
  });

  test("503 은 백오프로 재시도", async () => {
    mock.setModes({ responses: "unavailable", responses_times: 2 });
    expect(await collect(a)).toMatchObject({ outcome: "completed", attempts: 3 });
    mock.setModes({ responses: "unavailable", responses_times: 0 });
    expect(await collect(a)).toMatchObject({ outcome: "failed", recovery: "retry_backoff", attempts: 4 });
  });

  test("401 은 한 번 갱신하고 재시도", async () => {
    mock.setModes({ responses: "invalid_user", responses_times: 1 });
    expect(await collect(a)).toMatchObject({ outcome: "completed", attempts: 2 });
    expect(mock.stats.counts.token_refresh).toBe(1);
  });

  test("끊김·incomplete·403", async () => {
    mock.setModes({ responses: "drop" });
    expect(await collect(a)).toMatchObject({ outcome: "interrupted", code: "stream_ended" });
    mock.setModes({ responses: "incomplete" });
    expect(await collect(a)).toMatchObject({ outcome: "incomplete", code: "max_output_tokens" });
    mock.setModes({ responses: "not_eligible" });
    expect(await collect(a)).toMatchObject({ outcome: "failed", recovery: "not_eligible" });
  });

  test("취소", async () => {
    mock.setModes({ responses: "slow" });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 150);
    expect((await collect(a, req("a long message to stream slowly"), ctrl.signal)).outcome).toBe("cancelled");
  });

  test("첫 글자 마감", async () => {
    mock.setModes({ responses: "slow" });
    const r = await a.stream(req(), { onDelta: () => {}, firstTokenMs: 30 });
    expect(r).toMatchObject({ outcome: "timed_out", code: "first_token_timeout" });
  });
});

describe("토큰 갱신", () => {
  test("만료 임박이면 요청 전 갱신, 동시 요청은 한 번만", async () => {
    mock.setModes({ access_ttl: 60 }); // 120초 여유보다 짧음 → 매 요청 전 갱신 필요
    const a = makeAccount();
    await signIn(a);
    const results = await Promise.all([collect(a), collect(a), collect(a)]);
    expect(results.every((r) => r.outcome === "completed")).toBe(true);
    expect(mock.stats.counts.token_refresh).toBe(1);
  });

  test("영구 오류는 토큰 삭제 (등록 유지), 일시 장애는 유지", async () => {
    mock.setModes({ access_ttl: 60 });
    const a = makeAccount();
    await signIn(a);
    mock.setModes({ refresh: "unavailable" });
    expect((await collect(a)).recovery).toBe("retry_backoff");
    expect(a.info().signedIn).toBe(true);
    mock.setModes({ refresh: "invalid_grant" });
    expect(await collect(a)).toMatchObject({ outcome: "failed", recovery: "re_sign_in" });
    expect(a.info()).toMatchObject({ registered: true, signedIn: false });
  });

  test("갱신 응답의 다른 계정 ID 토큰은 거부", async () => {
    const a = makeAccount();
    await signIn(a);
    mock.setModes({ refresh_id: "bad_sub" });
    expect(await a.refresh()).toMatchObject({ ok: false, code: "refresh_id_token_invalid" });
    expect(a.info().signedIn).toBe(false);
  });

  test("갱신 응답의 같은 계정 ID 토큰은 수용", async () => {
    const a = makeAccount();
    await signIn(a);
    mock.setModes({ refresh_id: "same" });
    expect((await a.refresh()).ok).toBe(true);
    expect(a.info().signedIn).toBe(true);
  });
});

test("로그아웃은 진행 중인 스트림을 먼저 끊는다", async () => {
  const a = makeAccount();
  await signIn(a);
  mock.setModes({ responses: "slow" });
  const running = collect(a);
  await Bun.sleep(50);
  expect(await a.signOut(false)).toEqual({ ok: true, code: "" });
  expect((await running).outcome).not.toBe("completed");
});
