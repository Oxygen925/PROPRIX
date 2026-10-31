// 사이트 계정 저장 (P12c): 비밀번호는 응답에 없음, 주소 검사, 비밀 파일 정리, 연속 실패·2단계 인증이면 자동 로그인 중단
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Agent, AgentInput, type SiteAccount } from "@proprix/shared";
import { AgentStore, DEFAULT_PERSONA_ID } from "../agents/store";
import { FileSecretStore } from "../auth/secret-store";
import { migrate } from "../storage/db";
import { SiteAccountStore } from "./accounts";
import { unsafeLink } from "./policy";

const tmp = mkdtempSync(join(tmpdir(), "proprix-accounts-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PASSWORD = "test-pass-only";

function setup() {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  const agents = new AgentStore(db);
  const agent = agents.createAgent(AgentInput.parse({ personaId: DEFAULT_PERSONA_ID, name: "갑" })) as Agent;
  const dir = mkdtempSync(join(tmp, "site-"));
  const events: SiteAccount[] = [];
  const store = new SiteAccountStore(db, dir, (a) => events.push(a), { open: (p) => new FileSecretStore(p) });
  return { db, agents, agent, dir, store, events };
}
const input = {
  domain: "example.test",
  loginUrl: "https://www.example.test/login",
  username: "me",
  password: PASSWORD,
};
const created = (s: ReturnType<typeof setup>) => {
  const a = s.store.create(s.agent.id, input);
  if ("error" in a) throw new Error(a.message);
  return a;
};

test("비밀번호는 파일에만: 응답·이벤트·DB 에 없다", () => {
  const s = setup();
  const a = created(s);
  expect(JSON.stringify(a)).not.toContain(PASSWORD);
  expect(JSON.stringify(s.events)).not.toContain(PASSWORD);
  expect(JSON.stringify(s.db.query("SELECT * FROM site_accounts").all())).not.toContain(PASSWORD);
  expect(s.store.password(a.id)).toBe(PASSWORD);
});

test("ChatGPT·OpenAI 계정은 등록할 수 없다 (상위 도메인으로 등록해도)", () => {
  const s = setup();
  for (const [domain, loginUrl] of [
    ["chatgpt.com", "https://chatgpt.com/auth/login"],
    ["openai.com", "https://auth.openai.com/log-in"],
    ["auth.openai.com", "https://auth.openai.com/log-in"],
    ["com", "https://chatgpt.com/auth/login"],
    ["com", "https://example.com/login"], // 등록하면 chatgpt.com 에도 맞는 도메인
  ]) {
    const r = s.store.create(s.agent.id, { ...input, domain, loginUrl });
    expect("error" in r && r.message).toBe("ChatGPT·OpenAI 계정은 등록할 수 없습니다");
  }
  expect(readdirSync(s.dir)).toEqual([]);
  // 이름만 비슷한 다른 사이트는 된다
  expect(
    "error" in
      s.store.create(s.agent.id, { ...input, domain: "notchatgpt.com", loginUrl: "https://notchatgpt.com/login" }),
  ).toBe(false);
});

test("검사: https·등록 도메인 안의 로그인 주소, 같은 도메인 중복, 새 계정은 비밀번호 필수", () => {
  const s = setup();
  const bad = (raw: object) => {
    const r = s.store.create(s.agent.id, { ...input, ...raw });
    return "error" in r ? r.message : "";
  };
  expect(bad({ loginUrl: "http://example.test/login" })).toContain("https");
  expect(bad({ loginUrl: "https://evil.test/login" })).toContain("도메인 밖");
  expect(bad({ password: "" })).toContain("비밀번호");
  created(s);
  expect(bad({})).toContain("같은 도메인");
});

test("match 는 도메인과 하위만, 고칠 때 비밀번호를 비우면 그대로, 아이디를 바꾸면 세션을 지운다", () => {
  const s = setup();
  const a = created(s);
  expect(s.store.match(s.agent.id, "www.example.test")?.id).toBe(a.id);
  expect(s.store.match(s.agent.id, "notexample.test")).toBeNull();
  s.store.saveSession(a.id, [{ name: "c" }]);
  expect(s.store.get(a.id)?.hasSession).toBe(true);
  const up = s.store.update(a.id, { ...input, password: "" });
  expect("error" in up).toBe(false);
  expect(s.store.password(a.id)).toBe(PASSWORD);
  expect(s.store.session(a.id)).toHaveLength(1);
  s.store.update(a.id, { ...input, username: "other", password: "" });
  expect(s.store.get(a.id)?.hasSession).toBe(false);
});

test("연속 3회 실패하면 failed, 2단계 인증·CAPTCHA 는 바로 needs_attention, 성공하면 초기화", () => {
  const s = setup();
  const a = created(s);
  s.store.record(a.id, "wrong_credentials");
  s.store.record(a.id, "wrong_credentials");
  expect(s.store.canAutoLogin(s.store.get(a.id) as SiteAccount)).toBe(true);
  s.store.record(a.id, "wrong_credentials");
  expect(s.store.get(a.id)).toMatchObject({ status: "failed", lastError: "wrong_credentials" });
  expect(s.store.canAutoLogin(s.store.get(a.id) as SiteAccount)).toBe(false);
  s.store.record(a.id, "ok");
  expect(s.store.get(a.id)).toMatchObject({ status: "ok", lastError: "" });
  s.store.record(a.id, "two_factor");
  expect(s.store.get(a.id)?.status).toBe("needs_attention");
  expect(s.store.canAutoLogin(s.store.get(a.id) as SiteAccount)).toBe(false);
});

test("지우면 비밀 파일도 지워지고, 에이전트 삭제 뒤 prune 이 남은 파일을 지운다", () => {
  const s = setup();
  const a = created(s);
  s.store.saveSession(a.id, []);
  expect(readdirSync(s.dir)).toHaveLength(2);
  expect(s.store.delete(a.id)).toBe(true);
  expect(readdirSync(s.dir)).toHaveLength(0);

  const b = created(s);
  writeFileSync(join(s.dir, "stale.bin"), "x");
  s.store.prune();
  expect(readdirSync(s.dir)).toEqual([`${b.id}.bin`]);
  s.db.query("DELETE FROM site_accounts").run();
  s.store.prune();
  expect(readdirSync(s.dir)).toHaveLength(0);
});

test("따라가면 안 되는 링크", () => {
  expect(unsafeLink("https://a.test/logout")).toBe(true);
  expect(unsafeLink("https://a.test/x", "로그아웃")).toBe(true);
  expect(unsafeLink("https://a.test/pay/checkout")).toBe(true);
  expect(unsafeLink("https://a.test/board/12", "12월 공지")).toBe(false);
});
