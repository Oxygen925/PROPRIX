import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CALLBACK_PORT } from "@proprix/siwc";
import pkg from "../package.json";

export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 47800;

export interface DaemonConfig {
  port: number; // 0 = 빈 포트 자동 선택 (테스트)
  dataDir: string;
  webDir: string | null; // 빌드된 SPA. 없으면 API만 서빙
  apiToken: string;
  // daemon 자신 외에 허용할 브라우저 Origin (vite dev, Tauri 등)
  extraOrigins: string[];
  // 부트스트랩 링크의 기준 주소. dev 에서는 vite 프록시를 거쳐 쿠키가 UI origin 에 붙어야 한다
  uiOrigin: string | null;
  // 개발용 모의 SIWC 서버 주소 (http://127.0.0.1:<port> 만). null = 실제 OpenAI
  siwcBase: string | null;
  callbackPort: number; // SIWC 로그인 콜백 (최초 등록은 이 포트만)
  version: string;
  // Tauri 셸: 앱 데이터가 비어 있으면 이 폴더(개발용 .data)에서 한 번 가져온다
  importDir: string | null;
  // Tauri 셸: stdin 이 닫히면(셸 종료) 정리하고 끝낸다
  exitWithStdin: boolean;
}

function parseSiwcBase(raw: string | undefined): string | null {
  if (!raw) return null;
  // 실제 계정 토큰이 엉뚱한 곳으로 가지 않도록 loopback 만 허용한다 (자격 증명 파일도 issuer 별로 분리됨)
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(raw))
    throw new Error(`PROPRIX_SIWC_BASE 는 http://127.0.0.1:<port> 만 허용: ${raw}`);
  return raw.replace(/\/$/, "");
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  if (env.APPDATA) return join(env.APPDATA, "PROPRIX");
  return join(homedir(), ".local", "share", "proprix");
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`PROPRIX_PORT 가 올바르지 않음: ${raw}`);
  return n;
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new URL(s).origin);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const uiOrigin = env.PROPRIX_UI_ORIGIN ? new URL(env.PROPRIX_UI_ORIGIN).origin : null;
  const extraOrigins = parseOrigins(env.PROPRIX_ALLOWED_ORIGINS);
  if (uiOrigin && !extraOrigins.includes(uiOrigin)) extraOrigins.push(uiOrigin);
  return {
    port: parsePort(env.PROPRIX_PORT),
    dataDir: resolve(env.PROPRIX_DATA_DIR || defaultDataDir(env)),
    webDir: env.PROPRIX_WEB_DIR ? resolve(env.PROPRIX_WEB_DIR) : null,
    // Tauri 셸은 직접 생성한 token 을 넘긴다. 없으면 실행마다 새로 만든다
    apiToken: env.PROPRIX_API_TOKEN || randomBytes(32).toString("base64url"),
    extraOrigins,
    uiOrigin,
    siwcBase: parseSiwcBase(env.PROPRIX_SIWC_BASE),
    callbackPort: env.PROPRIX_CALLBACK_PORT ? parsePort(env.PROPRIX_CALLBACK_PORT) : DEFAULT_CALLBACK_PORT,
    version: pkg.version,
    importDir: env.PROPRIX_IMPORT_DIR ? resolve(env.PROPRIX_IMPORT_DIR) : null,
    exitWithStdin: env.PROPRIX_EXIT_WITH_STDIN === "1",
  };
}
