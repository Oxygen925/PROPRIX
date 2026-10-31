// loopback API 보호: Host 검사(DNS rebinding), Origin 검사(다른 웹페이지의 CSRF·WS 하이재킹), 인증(bearer 또는 세션 쿠키).
// 브라우저 세션은 파일에 남겨 daemon 을 다시 켜도 유지한다 (링크를 다시 열 필요 없게). 파일에는 세션 id 의 해시만 둔다
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SESSION_COOKIE } from "@proprix/shared";
import type { SecretStore } from "../auth/secret-store";

const BOOTSTRAP_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

const sessionKey = (sid: string) => createHash("sha256").update(sid).digest("base64url");

export type AuthVia = "bearer" | "cookie";

export class Guard {
  private readonly tokenBuf: Buffer;
  private readonly allowedHosts: Set<string>;
  private readonly allowedOrigins: Set<string>;
  private readonly bootstrapCodes = new Map<string, number>(); // code → 만료 시각
  private readonly sessions = new Map<string, number>(); // 세션 id 해시 → 만료 시각

  constructor(
    apiToken: string,
    port: number,
    extraOrigins: readonly string[],
    private readonly now: () => number = Date.now,
    private readonly store: SecretStore | null = null,
  ) {
    this.loadSessions();
    this.tokenBuf = Buffer.from(apiToken);
    this.allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    this.allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extraOrigins]);
    for (const o of extraOrigins) this.allowedHosts.add(new URL(o).host);
  }

  private loadSessions() {
    try {
      const saved = JSON.parse(this.store?.read() ?? "{}") as Record<string, number>;
      for (const [k, expires] of Object.entries(saved)) if (expires > this.now()) this.sessions.set(k, expires);
    } catch {
      // 못 읽으면 링크로 다시 접속
    }
  }

  private saveSessions() {
    this.store?.write(JSON.stringify(Object.fromEntries(this.sessions)));
  }

  hostAllowed(req: Request): boolean {
    const host = req.headers.get("host");
    return host !== null && this.allowedHosts.has(host.toLowerCase());
  }

  // Origin 이 없으면 브라우저가 아닌 로컬 클라이언트(desktop_pet 등)로 보고 통과 — 인증은 별도로 필수
  originAllowed(req: Request): boolean {
    const origin = req.headers.get("origin");
    if (origin === null) return true;
    return this.allowedOrigins.has(origin);
  }

  authenticate(req: Request): AuthVia | null {
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ") && this.tokenMatches(auth.slice(7))) return "bearer";
    const sid = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
    if (sid && (this.sessions.get(sessionKey(sid)) ?? 0) > this.now()) return "cookie";
    return null;
  }

  // 브라우저 WebSocket 은 헤더를 붙일 수 없어 앱(Tauri)은 ?token= 으로 보낸다 (Origin 검사는 그대로)
  authenticateWs(req: Request, url: URL): AuthVia | null {
    const via = this.authenticate(req);
    if (via) return via;
    const token = url.searchParams.get("token");
    return token && this.tokenMatches(token) ? "bearer" : null;
  }

  // 허용된 다른 Origin(앱 창 등)에서 오는 요청에 붙일 CORS 헤더. 같은 origin·로컬 클라이언트는 없음
  corsHeaders(req: Request): Record<string, string> | null {
    const origin = req.headers.get("origin");
    if (!origin || !this.allowedOrigins.has(origin)) return null;
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
      "access-control-max-age": "600",
      vary: "origin",
    };
  }

  private tokenMatches(candidate: string): boolean {
    const buf = Buffer.from(candidate);
    return buf.length === this.tokenBuf.length && timingSafeEqual(buf, this.tokenBuf);
  }

  // 브라우저 접속용 1회용 코드. 터미널에 출력된 링크로만 전달된다
  issueBootstrapCode(): string {
    const code = randomBytes(24).toString("base64url");
    this.bootstrapCodes.set(code, this.now() + BOOTSTRAP_TTL_MS);
    return code;
  }

  // 성공하면 새 세션 id
  redeemBootstrapCode(code: string): string | null {
    const expires = this.bootstrapCodes.get(code);
    if (expires === undefined) return null;
    this.bootstrapCodes.delete(code);
    if (this.now() > expires) return null;
    const sid = randomBytes(32).toString("base64url");
    for (const [k, until] of this.sessions) if (until <= this.now()) this.sessions.delete(k);
    this.sessions.set(sessionKey(sid), this.now() + SESSION_TTL_MS);
    this.saveSessions();
    return sid;
  }
}

export function sessionCookie(sid: string): string {
  return `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
