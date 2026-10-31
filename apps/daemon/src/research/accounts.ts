// 에이전트별 사이트 계정 (P12c): 주소·아이디·상태는 DB, 비밀번호와 로그인 쿠키는 암호화한 파일.
// API·이벤트·로그·LLM 요청에는 비밀번호를 넣지 않는다 (SiteAccount 타입에 아예 없음)
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type SiteAccount, SiteAccountInput, type SiteAccountOutcome } from "@proprix/shared";
import { createSecretStore, type SecretStore } from "../auth/secret-store";
import { domainMatches } from "./policy";

interface Row {
  id: string;
  agent_id: string;
  domain: string;
  login_url: string;
  username: string;
  status: SiteAccount["status"];
  last_error: string;
  failures: number;
  last_login_at: number | null;
  created_at: number;
}

export type AccountError = { error: "invalid" | "not_found"; message: string };

// 이만큼 연속 실패하면 자동 로그인을 멈춘다 (계정 잠김 방지). 사용자가 '로그인 시험'을 눌러야 다시 시도
const MAX_FAILURES = 3;
const ATTENTION: readonly SiteAccountOutcome[] = ["captcha", "two_factor"];
const OPENAI_DOMAINS = ["chatgpt.com", "chat.com", "openai.com"];

export class SiteAccountStore {
  constructor(
    private readonly db: Database,
    private readonly dir: string,
    private readonly onChange: (a: SiteAccount) => void = () => {},
    private readonly opt: {
      allowHttp?: boolean; // 개발 시험 전용: 로컬 시험 사이트
      open?: (path: string) => SecretStore;
      now?: () => number;
    } = {},
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string, kind: "password" | "session") {
    return join(this.dir, kind === "password" ? `${id}.bin` : `${id}.session.bin`);
  }

  private secret(id: string, kind: "password" | "session"): SecretStore {
    return (this.opt.open ?? createSecretStore)(this.path(id, kind));
  }

  private toAccount(r: Row): SiteAccount {
    return {
      id: r.id,
      agentId: r.agent_id,
      domain: r.domain,
      loginUrl: r.login_url,
      username: r.username,
      status: r.status,
      lastError: r.last_error,
      lastLoginAt: r.last_login_at,
      hasSession: existsSync(this.path(r.id, "session")),
      createdAt: r.created_at,
    };
  }

  list(agentId: string): SiteAccount[] {
    return this.db
      .query<Row, { a: string }>("SELECT * FROM site_accounts WHERE agent_id = $a ORDER BY domain")
      .all({ a: agentId })
      .map((r) => this.toAccount(r));
  }

  get(id: string): SiteAccount | null {
    const r = this.db.query<Row, { id: string }>("SELECT * FROM site_accounts WHERE id = $id").get({ id });
    return r ? this.toAccount(r) : null;
  }

  /** 이 에이전트가 이 호스트에 쓸 계정 (도메인과 그 하위) */
  match(agentId: string, host: string): SiteAccount | null {
    return this.list(agentId).find((a) => domainMatches(host, [a.domain])) ?? null;
  }

  private check(raw: unknown): ReturnType<typeof SiteAccountInput.parse> | AccountError {
    const p = SiteAccountInput.safeParse(raw);
    if (!p.success) return { error: "invalid", message: p.error.issues[0]?.message ?? "형식 오류" };
    const u = new URL(p.data.loginUrl);
    if (u.protocol !== "https:" && !this.opt.allowHttp)
      return { error: "invalid", message: "로그인 주소는 https 만 됩니다" };
    if (!domainMatches(u.hostname, [p.data.domain]))
      return { error: "invalid", message: "로그인 주소가 등록 도메인 밖입니다" };
    // SIWC 약관: 앱이 ChatGPT 비밀번호를 받으면 안 된다. 상위 도메인으로 등록해 넘어가는 것도 막는다
    if (OPENAI_DOMAINS.some((d) => domainMatches(u.hostname, [d]) || domainMatches(d, [p.data.domain])))
      return { error: "invalid", message: "ChatGPT·OpenAI 계정은 등록할 수 없습니다" };
    return p.data;
  }

  create(agentId: string, raw: unknown): SiteAccount | AccountError {
    const t = this.check(raw);
    if ("error" in t) return t;
    if (!t.password) return { error: "invalid", message: "비밀번호를 입력하세요" };
    if (this.list(agentId).some((a) => a.domain === t.domain))
      return { error: "invalid", message: "이 에이전트에 같은 도메인의 계정이 있습니다" };
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO site_accounts (id, agent_id, domain, login_url, username, created_at)
         VALUES ($id, $agent, $domain, $url, $user, $now)`,
      )
      .run({
        id,
        agent: agentId,
        domain: t.domain,
        url: t.loginUrl,
        user: t.username,
        now: (this.opt.now ?? Date.now)(),
      });
    this.secret(id, "password").write(t.password);
    return this.changed(id);
  }

  update(id: string, raw: unknown): SiteAccount | AccountError {
    const prev = this.get(id);
    if (!prev) return { error: "not_found", message: "없는 계정" };
    const t = this.check(raw);
    if ("error" in t) return t;
    if (this.list(prev.agentId).some((a) => a.id !== id && a.domain === t.domain))
      return { error: "invalid", message: "이 에이전트에 같은 도메인의 계정이 있습니다" };
    this.db
      .query(
        `UPDATE site_accounts SET domain = $domain, login_url = $url, username = $user, status = 'unknown',
         last_error = '', failures = 0 WHERE id = $id`,
      )
      .run({ id, domain: t.domain, url: t.loginUrl, user: t.username });
    if (t.password) this.secret(id, "password").write(t.password);
    if (t.domain !== prev.domain || t.username !== prev.username || t.password) this.secret(id, "session").remove();
    return this.changed(id);
  }

  delete(id: string): boolean {
    const n = this.db.query("DELETE FROM site_accounts WHERE id = $id").run({ id }).changes;
    this.secret(id, "password").remove();
    this.secret(id, "session").remove();
    return n > 0;
  }

  /** 행이 사라진 계정의 비밀 파일을 지운다 (에이전트 삭제는 DB 에서 cascade) */
  prune() {
    const ids = new Set(
      this.db
        .query<{ id: string }, []>("SELECT id FROM site_accounts")
        .all()
        .map((r) => r.id),
    );
    for (const f of readdirSync(this.dir)) {
      const id = f.replace(/(\.session)?\.bin$/, "");
      if (!ids.has(id)) rmSync(join(this.dir, f), { force: true });
    }
  }

  /** 자동 로그인을 해도 되는가 */
  canAutoLogin(a: SiteAccount): boolean {
    return a.status !== "failed" && a.status !== "needs_attention";
  }

  password(id: string): string | null {
    return this.secret(id, "password").read();
  }

  session(id: string): unknown[] {
    const raw = this.secret(id, "session").read();
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  saveSession(id: string, cookies: unknown[]) {
    this.secret(id, "session").write(JSON.stringify(cookies));
  }

  /** 로그인 시도 결과 */
  record(id: string, outcome: SiteAccountOutcome): SiteAccount | null {
    const a = this.db.query<Row, { id: string }>("SELECT * FROM site_accounts WHERE id = $id").get({ id });
    if (!a) return null;
    if (outcome === "ok")
      this.db
        .query(
          "UPDATE site_accounts SET status = 'ok', last_error = '', failures = 0, last_login_at = $now WHERE id = $id",
        )
        .run({ id, now: (this.opt.now ?? Date.now)() });
    else {
      const failures = a.failures + 1;
      const status = ATTENTION.includes(outcome) ? "needs_attention" : failures >= MAX_FAILURES ? "failed" : "unknown";
      this.db
        .query("UPDATE site_accounts SET status = $status, last_error = $outcome, failures = $failures WHERE id = $id")
        .run({ id, status, outcome, failures });
    }
    return this.changed(id);
  }

  private changed(id: string): SiteAccount {
    const a = this.get(id) as SiteAccount;
    this.onChange(a);
    return a;
  }
}
