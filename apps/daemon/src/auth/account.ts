// SIWC 계정: 로그인(loopback 콜백), 토큰 저장·갱신, 모델 목록, Responses 스트리밍, 로그아웃.
// desktop_pet src/platform/windows/ai/siwc_client.cpp (실계정 검증 2026-10-14) 의 흐름을 따른다.
// 로그 규칙: 토큰·인가 URL(id_token_hint 포함 가능)·콜백 query(인가 코드)·대화 원문은 기록하지 않는다.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccountInfo, ModelInfo, Recovery, SignInResult } from "@proprix/shared";
import {
  type AiRequest,
  applyDiscovery,
  buildAuthorizeUrl,
  buildResponsesRequest,
  CALLBACK_PATH,
  classifyErrorCode,
  classifyHttpError,
  classifyRefreshError,
  codeExchangeBody,
  DEFAULT_CALLBACK_PORT,
  discoveryUrl,
  findRsaJwk,
  hasPlanUsage,
  interpretEvent,
  isObject,
  isProduction,
  needsRefresh,
  parseCallback,
  parseJwt,
  parseModels,
  parseObject,
  parseTokenResponse,
  pkceChallenge,
  randomToken,
  redirectUri,
  refreshBody,
  revokeBody,
  type SiwcEndpoints,
  SseParser,
  type TokenSet,
  validateIdTokenClaims,
  verifyRs256,
} from "@proprix/siwc";
import type { Server } from "bun";
import { createSecretStore, type SecretStore } from "./secret-store";

interface Registration {
  clientId: string;
  subject: string;
  email: string;
  idToken: string; // 다시 로그인 때 id_token_hint. 로그아웃하면 지운다
  planGranted: boolean;
}

interface SavedState {
  version: 1;
  issuer: string;
  welcomeShown: boolean;
  registration?: Registration;
  tokens?: TokenSet;
}

export interface AccountOptions {
  endpoints: SiwcEndpoints;
  authDir: string;
  agentName?: string;
  callbackPort?: number;
  callbackTimeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  // 테스트: 메모리 저장소
  store?: SecretStore;
  now?: () => number; // unix 초
}

export interface OpResult {
  ok: boolean;
  code: string;
  recovery: Recovery;
  http: number;
}

export type StreamOutcome = "completed" | "cancelled" | "incomplete" | "interrupted" | "timed_out" | "failed";

export interface StreamResult {
  outcome: StreamOutcome;
  code: string;
  param: string;
  recovery: Recovery;
  http: number;
  attempts: number;
  chars: number;
  requestId: string;
  items: Record<string, unknown>[]; // 완성된 출력 항목 (도구 루프에서 그대로 다시 보낸다)
}

export interface StreamOptions {
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onSearch?: () => void; // 내장 웹 검색을 시작했을 때
  firstTokenMs?: number; // 시도마다 요청 전송부터 첫 글자까지 (백오프 제외)
  totalMs?: number; // 백오프·갱신 포함 요청 전체
}

export interface SignInAttempt {
  authorizeUrl: string;
  result: Promise<SignInResult>;
}

// 아직 시도하지 않은 실패 결과
export const failedResult = (code: string, recovery: Recovery): StreamResult => ({
  outcome: "failed",
  code,
  param: "",
  recovery,
  http: 0,
  attempts: 0,
  chars: 0,
  requestId: "",
  items: [],
});

const ok = (): OpResult => ({ ok: true, code: "", recovery: "none", http: 0 });
const fail = (code: string, recovery: Recovery = "none", http = 0): OpResult => ({ ok: false, code, recovery, http });

function fnv1aHex(s: string): string {
  let h = 2166136261;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class SiwcAccount {
  private endpoints: SiwcEndpoints;
  private readonly store: SecretStore;
  private readonly hostPath: string;
  private readonly agentName: string;
  private readonly callbackPort: number;
  private readonly callbackTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly now: () => number;

  private reg: Registration | null = null;
  private tokens: TokenSet | null = null;
  private readonly live = new Set<AbortController>(); // 진행 중인 스트림 시도 (로그아웃 때 끊는다)
  private welcomeShown = false;
  private discovered = false;
  private jwksCache = "";
  private refreshing: Promise<OpResult> | null = null; // 갱신 직렬화: 교체되는 refresh 토큰으로 경합하지 않게
  private signIn: { cancel: () => void } | null = null;

  constructor(opt: AccountOptions) {
    this.endpoints = opt.endpoints;
    // 자격 증명 파일은 issuer 별: 모의 서버 주소가 실제 계정 토큰을 읽거나 보낼 수 없다
    this.store = opt.store ?? createSecretStore(join(opt.authDir, `siwc-${fnv1aHex(opt.endpoints.issuer)}.bin`));
    this.hostPath = join(opt.authDir, "host_id.txt");
    this.agentName = opt.agentName ?? "PROPRIX";
    this.callbackPort = opt.callbackPort ?? DEFAULT_CALLBACK_PORT;
    this.callbackTimeoutMs = opt.callbackTimeoutMs ?? 5 * 60_000;
    this.maxRetries = opt.maxRetries ?? 3;
    this.retryBaseMs = opt.retryBaseMs ?? 1000;
    this.now = opt.now ?? (() => Math.floor(Date.now() / 1000));
    this.load();
  }

  // ---- 저장 ----

  private load() {
    const text = this.store.read();
    if (!text) return;
    const j = parseObject(text);
    if (!j || j.issuer !== this.endpoints.issuer) return;
    this.welcomeShown = j.welcomeShown === true;
    if (isObject(j.registration) && typeof j.registration.clientId === "string" && j.registration.clientId)
      this.reg = j.registration as unknown as Registration;
    if (this.reg && isObject(j.tokens)) this.tokens = j.tokens as unknown as TokenSet;
  }

  private save() {
    const state: SavedState = { version: 1, issuer: this.endpoints.issuer, welcomeShown: this.welcomeShown };
    if (this.reg) state.registration = this.reg;
    if (this.tokens) state.tokens = this.tokens;
    this.store.write(JSON.stringify(state));
  }

  private clearTokens() {
    this.tokens = null;
    this.save();
  }

  // ext_agent_host_id: 호스트마다 한 번 만들어 계속 쓴다. 불투명 값, 사용자 식별 정보 아님
  private hostId(): string {
    if (existsSync(this.hostPath)) {
      const id = readFileSync(this.hostPath, "utf8").trim();
      if (id.startsWith("urn:uuid:")) return id;
    }
    const id = `urn:uuid:${crypto.randomUUID()}`;
    mkdirSync(dirname(this.hostPath), { recursive: true });
    writeFileSync(`${this.hostPath}.tmp`, id);
    renameSync(`${this.hostPath}.tmp`, this.hostPath);
    return id;
  }

  info(): AccountInfo {
    return {
      registered: this.reg !== null,
      signedIn: this.tokens !== null,
      planUsage: this.tokens !== null && hasPlanUsage(this.tokens),
      email: this.reg?.email ?? "",
      welcomeShown: this.welcomeShown,
      mock: !isProduction(this.endpoints),
    };
  }

  markWelcomeShown() {
    this.welcomeShown = true;
    this.save();
  }

  // ---- 엔드포인트·ID 토큰 ----

  // OpenID 설정에서 엔드포인트를 받는다 (revoke 는 discovery 기준). 실패하면 내장값으로 계속
  private async ensureDiscovery() {
    if (this.discovered) return;
    try {
      const res = await fetch(discoveryUrl(this.endpoints), { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return console.warn(`[auth] discovery 실패 http=${res.status} — 내장 엔드포인트 사용`);
      const next = applyDiscovery(this.endpoints, await res.text());
      if (typeof next === "string") return console.warn(`[auth] discovery 무시: ${next}`);
      this.endpoints = next;
      this.discovered = true;
    } catch {
      console.warn("[auth] discovery 네트워크 오류 — 내장 엔드포인트 사용");
    }
  }

  private async jwks(forceReload: boolean): Promise<string> {
    if (this.jwksCache && !forceReload) return this.jwksCache;
    try {
      const res = await fetch(this.endpoints.jwks, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) this.jwksCache = await res.text();
    } catch {}
    return this.jwksCache;
  }

  // 성공하면 { subject, email }, 실패하면 사유
  private async verifyIdToken(idToken: string, clientId: string, nonce: string) {
    const jwt = parseJwt(idToken);
    if (!jwt) return "ID 토큰 형식 오류";
    const kid = typeof jwt.header.kid === "string" ? jwt.header.kid : "";
    const key = findRsaJwk(await this.jwks(false), kid) ?? findRsaJwk(await this.jwks(true), kid); // 키 교체 대비
    if (!key) return "JWKS 에서 서명 키를 찾지 못함";
    if (!(await verifyRs256(key, jwt.signingInput, jwt.signature))) return "ID 토큰 서명 불일치";
    return validateIdTokenClaims(jwt, this.endpoints.issuer, clientId, nonce, this.now());
  }

  private async postForm(url: string, body: string): Promise<{ status: number; body: string; requestId: string }> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      return { status: res.status, body: await res.text(), requestId: res.headers.get("x-request-id") ?? "" };
    } catch {
      return { status: 0, body: "", requestId: "" };
    }
  }

  // ---- 로그인 ----

  cancelSignIn() {
    this.signIn?.cancel();
  }

  // 콜백 수신을 시작하고 인가 URL 을 돌려준다. 브라우저는 호출한 쪽(UI)이 연다
  async beginSignIn(): Promise<SignInAttempt | SignInResult> {
    if (this.signIn) return { ok: false, code: "busy" };
    await this.ensureDiscovery();
    const registration = this.reg === null;
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    const pendingClientId = this.reg?.clientId ?? "";

    let settle!: (q: string | null, why: string) => void;
    const callback = new Promise<{ query: string | null; why: string }>((resolve) => {
      settle = (query, why) => resolve({ query, why });
    });

    const listen = (port: number): Server<undefined> =>
      Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch(req) {
          const url = new URL(req.url);
          // state 가 맞는 콜백만 받는다 (다른 요청은 400 으로 답하고 계속 기다림)
          if (url.pathname !== CALLBACK_PATH) return new Response("Not Found", { status: 404 });
          const query = url.search.slice(1);
          if (new URLSearchParams(query).get("state") !== state) return new Response("Bad Request", { status: 400 });
          settle(query, "callback");
          return new Response(CALLBACK_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
        },
      });

    let server: Server<undefined>;
    try {
      server = listen(this.callbackPort);
    } catch {
      // 최초 등록은 지정 포트만. 다시 로그인은 포트만 달라도 된다 ("Later sign-ins may use another available port")
      if (registration) return { ok: false, code: "port_in_use" };
      try {
        server = listen(0);
      } catch {
        return { ok: false, code: "listener_failed" };
      }
    }

    const redirect = redirectUri(server.port ?? this.callbackPort);
    const authorizeUrl = buildAuthorizeUrl(this.endpoints, {
      clientId: pendingClientId,
      agentName: this.agentName,
      hostId: this.hostId(),
      redirectUri: redirect,
      state,
      nonce,
      codeChallenge: pkceChallenge(verifier),
      idTokenHint: this.reg?.idToken,
      loginHint: this.reg?.email,
      reconsent: this.reg !== null && !this.reg.planGranted, // plan usage 없이 동의했던 등록: 동의 화면을 다시 띄운다
    });
    console.log(`[auth] signin start registration=${registration} port=${server.port}`);

    const timer = setTimeout(() => settle(null, "timeout"), this.callbackTimeoutMs);
    this.signIn = { cancel: () => settle(null, "cancelled") };

    const result = (async (): Promise<SignInResult> => {
      const { query, why } = await callback;
      clearTimeout(timer);
      // 성공·취소·시간 초과 모두 여기서 포트를 놓는다. 콜백이면 브라우저에 보낼 응답이 끝난 뒤 닫는다
      void server.stop(query === null);
      try {
        if (query === null) return { ok: false, code: why };
        return await this.completeSignIn(query, state, nonce, verifier, redirect, pendingClientId, registration);
      } finally {
        this.signIn = null;
      }
    })();
    result.then((r) => console.log(`[auth] signin ${r.ok ? "ok" : r.code}`));
    return { authorizeUrl, result };
  }

  private async completeSignIn(
    query: string,
    state: string,
    nonce: string,
    verifier: string,
    redirect: string,
    pendingClientId: string,
    registration: boolean,
  ): Promise<SignInResult> {
    const cb = parseCallback(query, state, pendingClientId);
    if (cb.kind === "denied") return { ok: false, code: "access_denied" };
    if (cb.kind === "invalid") {
      console.warn(`[auth] 콜백 거부: ${cb.error}`);
      return { ok: false, code: "invalid_callback" };
    }
    const res = await this.postForm(this.endpoints.token, codeExchangeBody(cb.clientId, cb.code, verifier, redirect));
    const tr = parseTokenResponse(res.status, res.body, this.now());
    if (!tr.ok) {
      console.warn(`[auth] 코드 교환 실패 http=${res.status} error=${tr.error} request_id=${res.requestId}`);
      return { ok: false, code: res.status === 0 ? "network" : tr.error || "token_exchange_failed" };
    }
    const id = await this.verifyIdToken(tr.tokens.idToken, cb.clientId, nonce);
    if (typeof id === "string") {
      console.warn(`[auth] ID 토큰 검증 실패: ${id}`);
      return { ok: false, code: "id_token_invalid" };
    }
    if (!registration && this.reg?.subject && this.reg.subject !== id.subject) {
      console.warn("[auth] 다시 로그인한 계정이 등록 계정과 다름 — 저장하지 않음");
      return { ok: false, code: "account_mismatch" };
    }
    this.reg = {
      clientId: cb.clientId,
      subject: id.subject,
      email: id.email,
      idToken: tr.tokens.idToken,
      planGranted: hasPlanUsage(tr.tokens),
    };
    this.tokens = tr.tokens;
    this.save();
    return { ok: true, code: "ok" };
  }

  // ---- 토큰 갱신 ----

  refresh(): Promise<OpResult> {
    // 동시에 여러 요청이 갱신을 원해도 한 번만 보낸다 (문서: serialize refreshes for the same session)
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<OpResult> {
    const reg = this.reg;
    const tokens = this.tokens;
    if (!reg || !tokens?.refreshToken) return fail("no_refresh_token", "re_sign_in");
    await this.ensureDiscovery();
    const res = await this.postForm(this.endpoints.token, refreshBody(reg.clientId, tokens.refreshToken));
    const tr = parseTokenResponse(res.status, res.body, this.now(), tokens);
    if (!tr.ok) {
      const recovery = classifyRefreshError(tr.error, res.status);
      console.warn(`[auth] token refresh 실패 http=${res.status} error=${tr.error} recovery=${recovery}`);
      if (recovery === "re_sign_in") this.clearTokens(); // 영구 오류만 삭제 (일시 장애는 유지)
      return fail(tr.error, recovery, res.status);
    }
    if (tr.tokens.idToken && tr.tokens.idToken !== tokens.idToken) {
      // 갱신 응답의 새 ID 토큰: 서명·클레임을 확인하고 같은 계정인지 본다 (nonce 없음)
      const id = await this.verifyIdToken(tr.tokens.idToken, reg.clientId, "");
      if (typeof id === "string" || (reg.subject && id.subject !== reg.subject)) {
        console.warn(`[auth] 갱신 응답의 ID 토큰 거부: ${typeof id === "string" ? id : "계정 불일치"}`);
        this.clearTokens();
        return fail("refresh_id_token_invalid", "re_sign_in");
      }
      reg.idToken = tr.tokens.idToken;
    }
    this.tokens = tr.tokens;
    this.save(); // 교체된 refresh 토큰을 먼저 저장한 뒤 새 access 토큰을 쓴다
    return ok();
  }

  private async ensureFreshToken(): Promise<OpResult> {
    if (!this.tokens) return fail("signed_out", "re_sign_in");
    if (needsRefresh(this.tokens, this.now())) return this.refresh();
    return ok();
  }

  // ---- 모델·추론 ----

  async listModels(): Promise<{ result: OpResult; models: ModelInfo[] }> {
    const fresh = await this.ensureFreshToken();
    if (!fresh.ok || !this.tokens) return { result: fresh, models: [] };
    try {
      const res = await fetch(`${this.endpoints.api}/models`, {
        headers: { authorization: `Bearer ${this.tokens.accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.text();
      if (!res.ok) {
        const e = classifyHttpError(res.status, body);
        console.warn(
          `[llm] models 실패 http=${res.status} code=${e.code} request_id=${res.headers.get("x-request-id") ?? ""}`,
        );
        return { result: fail(e.code || `http_${res.status}`, e.recovery, res.status), models: [] };
      }
      return { result: ok(), models: parseModels(body) };
    } catch {
      return { result: fail("network", "network"), models: [] };
    }
  }

  async stream(request: AiRequest, opt: StreamOptions): Promise<StreamResult> {
    const sr = failedResult("", "none");
    const body = buildResponsesRequest(request);
    const started = Date.now();
    const totalMs = opt.totalMs ?? 300_000;
    const firstTokenMs = opt.firstTokenMs ?? 90_000;
    let refreshedFor401 = false;
    const cancelled = () => opt.signal?.aborted === true;
    const finish = (outcome: StreamOutcome, code = sr.code, recovery: Recovery = sr.recovery) => {
      sr.outcome = outcome;
      sr.code = code;
      sr.recovery = recovery;
      return sr;
    };
    const backoff = async (attempt: number) =>
      attempt < this.maxRetries && (await sleep(this.retryBaseMs * 2 ** attempt, opt.signal));

    for (let attempt = 0; ; attempt++) {
      sr.attempts = attempt + 1;
      if (cancelled()) return finish("cancelled");
      if (Date.now() - started >= totalMs) return finish("timed_out", "request_timeout", "network");

      const fresh = await this.ensureFreshToken();
      if (!fresh.ok || !this.tokens) {
        sr.http = fresh.http;
        if (fresh.recovery === "retry_backoff" && (await backoff(attempt))) continue;
        return finish(cancelled() ? "cancelled" : "failed", fresh.code, fresh.recovery);
      }
      if (!hasPlanUsage(this.tokens)) return finish("failed", "plan_usage_disabled", "not_eligible"); // 로그인 유지, 추론 금지
      if (cancelled()) return finish("cancelled");

      // 시도별 마감: 첫 글자 전에는 firstTokenMs, 이후에는 남은 전체 시간
      const ctrl = new AbortController();
      this.live.add(ctrl);
      let timeoutReason = "";
      const abortWith = (why: string) => {
        timeoutReason ||= why;
        ctrl.abort();
      };
      const onUserAbort = () => ctrl.abort();
      opt.signal?.addEventListener("abort", onUserAbort, { once: true });
      const remaining = totalMs - (Date.now() - started);
      const totalTimer = setTimeout(() => abortWith("request_timeout"), remaining);
      let firstTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
        () => abortWith("first_token_timeout"),
        Math.min(firstTokenMs, remaining),
      );
      const clearTimers = () => {
        clearTimeout(totalTimer);
        clearTimeout(firstTimer);
        opt.signal?.removeEventListener("abort", onUserAbort);
        this.live.delete(ctrl);
      };

      let completed = false;
      let incomplete = "";
      let failed: { code: string } | null = null;
      let sawEvent = false;
      try {
        const res = await fetch(`${this.endpoints.api}/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.tokens.accessToken}`,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body,
          signal: ctrl.signal,
        });
        sr.http = res.status;
        sr.requestId = res.headers.get("x-request-id") ?? "";

        if (!res.ok || !res.body) {
          clearTimers();
          // 스트림 시작 전 오류 응답
          const e = classifyHttpError(res.status, await res.text());
          sr.param = e.param;
          console.warn(
            `[llm] responses http=${res.status} code=${e.code} recovery=${e.recovery} attempt=${sr.attempts} request_id=${sr.requestId}`,
          );
          if (e.recovery === "re_sign_in" && !refreshedFor401) {
            refreshedFor401 = true; // 401: 토큰을 한 번 갱신해 보고 재시도
            const rf = await this.refresh();
            if (rf.ok) continue;
            return finish("failed", rf.code || e.code || `http_${res.status}`, "re_sign_in");
          }
          if (e.recovery === "retry_backoff" && (await backoff(attempt))) continue;
          return finish(cancelled() ? "cancelled" : "failed", e.code || `http_${res.status}`, e.recovery);
        }

        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        sr.items = [];
        // 첫 글자 마감은 글자뿐 아니라 첫 출력 항목(도구 호출만 있는 응답)으로도 푼다
        const firstOutput = () => {
          if (firstTimer) {
            clearTimeout(firstTimer);
            firstTimer = undefined;
          }
        };
        const handle = (events: ReturnType<SseParser["feed"]>) => {
          for (const e of events) {
            sawEvent = true;
            const u = interpretEvent(e);
            if (u.kind === "delta" && u.text) {
              firstOutput();
              sr.chars += [...u.text].length;
              opt.onDelta(u.text);
            } else if (u.kind === "searching") {
              firstOutput();
              opt.onSearch?.();
            } else if (u.kind === "item") {
              firstOutput();
              sr.items.push(u.item);
            } else if (u.kind === "completed") completed = true;
            else if (u.kind === "incomplete") incomplete = u.reason || "incomplete";
            else if (u.kind === "failed" || u.kind === "error") failed = { code: u.code };
            if (completed || incomplete || failed) return true;
          }
          return false;
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            handle(parser.feed(decoder.decode()));
            handle(parser.finish());
            break;
          }
          if (handle(parser.feed(decoder.decode(value, { stream: true })))) {
            await reader.cancel().catch(() => {});
            break;
          }
        }
      } catch {
        // abort(취소·마감) 또는 네트워크 끊김 — 아래에서 구분
      } finally {
        clearTimers();
      }

      if (completed) return finish("completed", "", "none");
      if (incomplete) return finish("incomplete", incomplete, "none");
      if (failed) {
        const code = (failed as { code: string }).code;
        return finish("failed", code, classifyErrorCode(code, 0));
      }
      if (cancelled()) return finish("cancelled");
      if (timeoutReason) return finish("timed_out", timeoutReason, "network");
      if (sr.http === 0) return finish("failed", "network", "network");
      return finish("interrupted", sawEvent ? "stream_ended" : "no_events", "network"); // completed 없이 끝남
    }
  }

  // ---- 로그아웃 ----

  // revoke 200 이면 로컬 토큰 삭제. 실패하면 유지하고, forceLocal 이면 지우되 "원격 해제 미확인"을 알린다.
  // ID 토큰(id_token_hint)도 지운다 — 로그아웃 뒤 힌트를 보내면 확인 페이지가 뜬다 (실계정 검증 7번).
  // 등록(client_id·host id)과 이메일(login_hint)은 다시 로그인을 위해 유지한다
  async signOut(forceLocal: boolean): Promise<{ ok: boolean; code: string }> {
    if (!this.tokens) return { ok: true, code: "" };
    for (const c of this.live) c.abort(); // 문서: 진행 중인 요청을 먼저 멈춘 뒤 revoke
    if (this.reg && this.tokens.refreshToken) {
      await this.ensureDiscovery();
      let status = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await sleep(300); // 5xx·네트워크 오류만 1회 재시도
        status = (await this.postForm(this.endpoints.revoke, revokeBody(this.reg.clientId, this.tokens.refreshToken)))
          .status;
        if (status !== 0 && status < 500) break;
      }
      if (status === 200) {
        this.reg.idToken = "";
        this.clearTokens();
        console.log("[auth] signout revoked");
        return { ok: true, code: "" };
      }
      console.warn(`[auth] revoke 실패 http=${status}`);
    }
    if (forceLocal) {
      if (this.reg) this.reg.idToken = "";
      this.clearTokens();
      return { ok: true, code: "revoke_unconfirmed" };
    }
    return { ok: false, code: "revoke_failed" };
  }
}

const CALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>PROPRIX</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>PROPRIX</h1><p>로그인 응답을 받았습니다. 이 탭을 닫고 PROPRIX 로 돌아가세요.</p></body>`;
