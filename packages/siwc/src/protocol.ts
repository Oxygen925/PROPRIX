// Sign in with ChatGPT (ChatGPT plan usage, 오픈소스·로컬 앱 흐름) 프로토콜 — 순수 로직.
// 근거: developers.openai.com/siwc/token-sharing-open-source/* 와 desktop_pet(src/ai/siwc_protocol.cpp, 실계정 검증 2026-10-14)의 이식.
// 네트워크·저장은 호출하는 쪽이 맡고, 여기서는 URL·본문 생성, 응답 해석, 검증 규칙, 오류 분류만 한다.
import { createHash, randomBytes } from "node:crypto";

export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const RESOURCE = "https://api.openai.com/v1";
export const CALLBACK_PATH = "/auth/callback";
export const USAGE_URL = "https://chatgpt.com/settings/usage";
export const DEFAULT_CALLBACK_PORT = 1455;

// ---- 엔드포인트 ----

export interface SiwcEndpoints {
  issuer: string;
  authorize: string;
  token: string;
  revoke: string;
  jwks: string;
  api: string;
}

export function productionEndpoints(): SiwcEndpoints {
  return {
    issuer: "https://auth.openai.com",
    authorize: "https://auth.openai.com/api/accounts/authorize",
    token: "https://auth.openai.com/api/accounts/oauth/token",
    revoke: "https://auth.openai.com/api/accounts/oauth/revoke",
    jwks: "https://auth.openai.com/.well-known/jwks.json",
    api: "https://api.openai.com/v1",
  };
}

// 모의 서버: base 아래 같은 경로 구조, issuer = base
export function endpointsForBase(base: string): SiwcEndpoints {
  const b = base.replace(/\/+$/, "");
  return {
    issuer: b,
    authorize: `${b}/api/accounts/authorize`,
    token: `${b}/api/accounts/oauth/token`,
    revoke: `${b}/api/accounts/oauth/revoke`,
    jwks: `${b}/.well-known/jwks.json`,
    api: `${b}/v1`,
  };
}

export const isProduction = (ep: SiwcEndpoints) => ep.issuer === productionEndpoints().issuer;
export const discoveryUrl = (ep: SiwcEndpoints) => `${ep.issuer}/.well-known/openid-configuration`;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// OpenID 설정 문서로 인증 엔드포인트를 갱신한다. issuer 가 일치하고 모든 엔드포인트가 issuer 와 같은 origin 일 때만.
// 성공하면 새 엔드포인트, 실패하면 사유 문자열. API 주소는 discovery 대상이 아니다
export function applyDiscovery(ep: SiwcEndpoints, discoveryJson: string): SiwcEndpoints | string {
  const j = parseObject(discoveryJson);
  if (!j) return "discovery JSON 아님";
  if (str(j, "issuer") !== ep.issuer) return "discovery issuer 불일치";
  const want = originOf(ep.issuer);
  const next = { ...ep };
  const fields = [
    ["authorization_endpoint", "authorize"],
    ["token_endpoint", "token"],
    ["revocation_endpoint", "revoke"],
    ["jwks_uri", "jwks"],
  ] as const;
  for (const [key, field] of fields) {
    const v = str(j, key);
    if (!v) return `${key} 없음`;
    if (originOf(v) !== want) return `${key} 가 issuer 와 다른 origin`;
    next[field] = v;
  }
  return next;
}

// ---- 인코딩 ----

// RFC 3986 unreserved 만 그대로 둔다 (encodeURIComponent 는 !'()* 를 남김)
export function urlEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function formEncode(fields: readonly (readonly [string, string])[]): string {
  return fields.map(([k, v]) => `${urlEncode(k)}=${urlEncode(v)}`).join("&");
}

export function base64UrlEncode(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

export function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> | null {
  const t = s.replace(/=+$/, "");
  if (t.length % 4 === 1 || !/^[A-Za-z0-9_\-+/]*$/.test(t)) return null;
  return new Uint8Array(Buffer.from(t.replace(/\+/g, "-").replace(/\//g, "_"), "base64url"));
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ---- 인가 ----

export interface AuthorizeParams {
  clientId: string; // 비면 최초 등록 (dynamic_agent_client + agent_name_hint)
  agentName: string; // 최초 등록에만 전송
  hostId: string; // ext_agent_host_id (항상)
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  idTokenHint?: string; // 다시 로그인에만. 로그아웃 뒤에는 생략 (실계정 검증: 보내면 확인 페이지가 뜸)
  loginHint?: string;
  reconsent?: boolean; // prompt=consent: plan usage 없이 동의했던 등록 (DevKit 동작, 문서 미기재)
}

export const redirectUri = (port: number) => `http://127.0.0.1:${port}${CALLBACK_PATH}`;

export function buildAuthorizeUrl(ep: SiwcEndpoints, p: AuthorizeParams): string {
  const registration = p.clientId === "";
  const q: [string, string][] = [["client_id", registration ? DYNAMIC_CLIENT_ID : p.clientId]];
  if (registration) q.push(["agent_name_hint", p.agentName]);
  q.push(
    ["ext_agent_host_id", p.hostId],
    ["response_type", "code"],
    ["redirect_uri", p.redirectUri],
    ["scope", SCOPES],
    ["resource", RESOURCE],
    ["state", p.state],
    ["nonce", p.nonce],
    ["code_challenge_method", "S256"],
    ["code_challenge", p.codeChallenge],
  );
  if (!registration && p.idTokenHint) q.push(["id_token_hint", p.idTokenHint]);
  if (!registration && p.loginHint) q.push(["login_hint", p.loginHint]);
  if (!registration && p.reconsent) q.push(["prompt", "consent"]);
  return `${ep.authorize}?${formEncode(q)}`;
}

export type CallbackResult =
  | { kind: "code"; code: string; clientId: string; scope: string }
  | { kind: "denied"; error: string }
  | { kind: "invalid"; error: string };

// state 를 가장 먼저 검증한다 (거부 응답도 state 확인 후에만 신뢰). pendingClientId 가 비면(최초 등록) 콜백에 발급
// client_id 가 있어야 하고, 비어 있지 않으면 콜백의 client_id 는 생략 가능하되 다르면 거부한다
export function parseCallback(query: string, expectedState: string, pendingClientId: string): CallbackResult {
  const q = new URLSearchParams(query);
  const get = (k: string) => q.get(k) ?? "";
  if (!expectedState || get("state") !== expectedState) return { kind: "invalid", error: "state 불일치" };
  const error = get("error");
  if (error) return error === "access_denied" ? { kind: "denied", error } : { kind: "invalid", error };
  const code = get("code");
  let clientId = get("client_id");
  if (!code) return { kind: "invalid", error: "code 없음" };
  if (!pendingClientId) {
    if (!clientId || clientId === DYNAMIC_CLIENT_ID)
      return { kind: "invalid", error: "발급 client_id 없음 (등록 미완료)" };
  } else {
    if (clientId && clientId !== pendingClientId) return { kind: "invalid", error: "client_id 불일치" };
    clientId = pendingClientId;
  }
  return { kind: "code", code, clientId, scope: get("scope") };
}

// ---- 토큰 ----

export function codeExchangeBody(clientId: string, code: string, verifier: string, redirect: string): string {
  return formEncode([
    ["grant_type", "authorization_code"],
    ["client_id", clientId],
    ["code", code],
    ["code_verifier", verifier],
    ["redirect_uri", redirect],
    ["resource", RESOURCE],
  ]);
}

// scope 를 생략하면 기존 권한 유지 (profiles-and-sessions)
export function refreshBody(clientId: string, refreshToken: string): string {
  return formEncode([
    ["grant_type", "refresh_token"],
    ["client_id", clientId],
    ["refresh_token", refreshToken],
    ["resource", RESOURCE],
  ]);
}

export function revokeBody(clientId: string, refreshToken: string): string {
  return formEncode([
    ["token", refreshToken],
    ["token_type_hint", "refresh_token"],
    ["client_id", clientId],
  ]);
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  tokenType: string;
  expiresAt: number; // unix 초
  scopes: string[];
}

export const hasPlanUsage = (t: TokenSet) => t.scopes.includes(PLAN_SCOPE);

export type TokenResult = { ok: true; tokens: TokenSet } | { ok: false; error: string; errorDescription: string };

// previous: 갱신 응답에 빠진 필드(id_token·refresh_token·scope)를 이전 값으로 채운다
export function parseTokenResponse(status: number, body: string, nowUnix: number, previous?: TokenSet): TokenResult {
  const j = parseObject(body);
  if (status !== 200) {
    let error = "";
    let errorDescription = "";
    if (j) {
      error = str(j, "error");
      errorDescription = str(j, "error_description");
      if (!error && isObject(j.error)) error = str(j.error, "code");
    }
    return { ok: false, error: error || `http_${status}`, errorDescription };
  }
  if (!j || typeof j.access_token !== "string") return { ok: false, error: "invalid_response", errorDescription: "" };
  const expiresIn = typeof j.expires_in === "number" ? j.expires_in : 3600;
  return {
    ok: true,
    tokens: {
      accessToken: j.access_token,
      refreshToken: str(j, "refresh_token") || (previous?.refreshToken ?? ""),
      idToken: str(j, "id_token") || (previous?.idToken ?? ""),
      tokenType: str(j, "token_type") || "Bearer",
      expiresAt: nowUnix + Math.max(0, expiresIn),
      scopes: typeof j.scope === "string" ? j.scope.split(/\s+/).filter(Boolean) : (previous?.scopes ?? []),
    },
  };
}

export const needsRefresh = (t: TokenSet, nowUnix: number, marginSec = 120) => nowUnix + marginSec >= t.expiresAt;

// ---- 오류 분류 (errors-and-recovery) ----

export type Recovery =
  | "none"
  | "retry_backoff" // 503 계열: 자격 증명 유지, 제한된 백오프
  | "re_sign_in" // 401·invalid_user·갱신 영구 오류
  | "usage_limit" // 429 usage_limit_exceeded: 새 요청 중지 + Manage usage
  | "not_eligible" // 403 user_not_eligible·범위 없음: 재시도·OAuth 반복 금지
  | "restricted" // 403 정책·지역 제한
  | "fix_request" // 400 unsupported_capability·route_not_supported
  | "client_config" // invalid_client·chatpass_v2_*
  | "network"
  | "unknown";

export function classifyErrorCode(code: string, http: number): Recovery {
  switch (code) {
    case "subscription_sharing_user_not_eligible":
      return "not_eligible";
    case "subscription_sharing_usage_limit_exceeded":
      return "usage_limit";
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return "retry_backoff";
    case "subscription_sharing_unsupported_capability":
    case "subscription_sharing_route_not_supported":
      return "fix_request";
    case "subscription_sharing_invalid_user":
      return "re_sign_in";
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return "client_config";
  }
  // 코드가 없거나 모르는 코드: HTTP 상태로
  if (http === 401) return "re_sign_in";
  if (http === 403) return "restricted";
  if (http === 429) return "usage_limit";
  if (http === 500 || http === 502 || http === 503 || http === 504) return "retry_backoff";
  if (http === 400) return "fix_request";
  return "unknown";
}

export interface ApiErrorInfo {
  http: number;
  code: string;
  param: string;
  message: string;
  recovery: Recovery;
}

// 스트림 시작 전 오류 응답
export function classifyHttpError(http: number, body: string): ApiErrorInfo {
  const e: ApiErrorInfo = { http, code: "", param: "", message: "", recovery: "unknown" };
  const j = parseObject(body);
  if (j) {
    if (isObject(j.error)) {
      e.code = str(j.error, "code");
      e.param = str(j.error, "param");
      e.message = str(j.error, "message");
    } else if (typeof j.detail === "string") {
      e.message = j.detail; // 안정 코드 없음 → 진단 문구로만
    }
  }
  e.recovery = classifyErrorCode(e.code, http);
  return e;
}

const PERMANENT_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export function classifyRefreshError(error: string, http: number): Recovery {
  if (PERMANENT_REFRESH_ERRORS.has(error)) return "re_sign_in";
  if (error === "invalid_client") return "client_config";
  if (http >= 500 || http === 0) return "retry_backoff"; // 일시 장애: 자격 증명 유지
  if (http === 400 || http === 401) return "re_sign_in";
  return "unknown";
}

// ---- JSON 도우미 (신뢰할 수 없는 입력: 타입이 틀려도 던지지 않는다) ----

export type JsonObject = Record<string, unknown>;

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseObject(text: string): JsonObject | null {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

export function str(o: unknown, key: string): string {
  if (!isObject(o)) return "";
  const v = o[key];
  return typeof v === "string" ? v : "";
}
