// 자율 웹 리서치 (P11): 설정·브라우저 상태 (사용자 결정 2026-10-30)
import { z } from "zod";
import { TaskSchedule } from "./tasks";

// 차단 도메인: 이 도메인과 하위 도메인은 읽지 않는다 (로컬·사설망 주소는 설정과 관계없이 늘 차단)
export const ResearchSettings = z.object({
  denyDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]+$/, "도메인은 example.com 형식"),
    )
    .max(200),
});
export type ResearchSettings = z.infer<typeof ResearchSettings>;
export const DEFAULT_RESEARCH: ResearchSettings = { denyDomains: [] };

// 리서치 브라우저 (Chromium headless shell): 처음 쓸 때 설정에서 내려받는다
export const BrowserStatus = z.object({
  version: z.string(), // 이 앱이 쓰는 Chromium 버전
  installed: z.boolean(),
  size: z.number(), // 설치된 크기 (바이트)
  downloadSize: z.number(), // 내려받을 크기 (바이트)
  installing: z
    .object({ received: z.number(), total: z.number(), stage: z.enum(["download", "extract"]).default("download") })
    .nullable(),
  error: z.string(),
});
export type BrowserStatus = z.infer<typeof BrowserStatus>;

export const RESEARCH_USER_AGENT = "PROPRIX-Research";

// ---- 리서치 작업 (P11b) ----

export const RESEARCH_LIMITS = { maxPages: 40, depth: 2, queries: 8 } as const;

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+$/, "도메인은 example.com 형식");

export const ResearchScope = z.object({
  maxPages: z.number().int().min(1).max(RESEARCH_LIMITS.maxPages).default(15), // 읽을 페이지 수 상한
  depth: z.number().int().min(0).max(RESEARCH_LIMITS.depth).default(1), // 검색 결과에서 링크를 따라갈 깊이
  queries: z.number().int().min(1).max(RESEARCH_LIMITS.queries).default(4), // 검색어 수
  domains: z.array(domain).max(20).default([]), // 허용 도메인: 비우면 제한 없음, 있으면 이 도메인(하위 포함)만
  // 시작 주소 (P12a): 검색 결과와 함께 깊이 0 으로 읽는다 (검색에 안 잡히는 회원 전용 페이지 등)
  startUrls: z
    .array(
      z
        .string()
        .trim()
        .regex(/^https?:\/\/\S+$/i, "시작 주소는 http(s):// 로 시작"),
    )
    .max(20)
    .default([]),
});
export type ResearchScope = z.infer<typeof ResearchScope>;

// 결과 저장: 메모, 또는 작업 폴더가 있는 대화의 파일 (앱이 직접 쓴다 — 모델 쓰기 도구가 아님)
export const ResearchOutput = z.discriminatedUnion("target", [
  z.object({ target: z.literal("note") }),
  z.object({ target: z.literal("file"), roomId: z.string().min(1), path: z.string().trim().min(1).max(200) }),
]);
export type ResearchOutput = z.infer<typeof ResearchOutput>;

// 복수 에이전트의 결과 방식 (P12b, 리서치마다 고름): 각자 조사·각자 글 / 각자 조사 후 합친 글 추가 / 자료 공유·글만 각자
export const ResearchMode = z.enum(["separate", "merged", "shared"]);
export type ResearchMode = z.infer<typeof ResearchMode>;
export const RESEARCH_MAX_AGENTS = 8;

// 대략의 요청 수 (시작 전 예산 검사·대화상자 안내)
export function researchRequests(
  scope: { queries: number; maxPages: number },
  agents: number,
  mode: ResearchMode,
): number {
  const one = scope.queries + scope.maxPages + 1; // 검색어 만들기 1 + 검색 + 페이지 요약
  if (mode === "shared") return one + agents;
  return (one + 1) * agents + (mode === "merged" && agents > 1 ? 1 : 0);
}

export const ResearchInput = z.object({
  title: z.string().trim().min(1).max(100),
  goal: z.string().trim().min(1).max(2000),
  instruction: z.string().trim().max(2000).default(""),
  agentIds: z.array(z.string().min(1)).min(1, "에이전트를 한 명 이상 고르세요").max(RESEARCH_MAX_AGENTS), // 첫 번째가 대표
  mode: ResearchMode.default("separate"),
  scope: ResearchScope.default({ maxPages: 15, depth: 1, queries: 4, domains: [], startUrls: [] }),
  output: ResearchOutput.default({ target: "note" }),
  schedule: TaskSchedule.nullable().default(null), // 반복 예약 (P11c)
  enabled: z.boolean().default(true),
});
export type ResearchInput = z.input<typeof ResearchInput>;

export const ResearchRunStatus = z.enum(["running", "done", "partial", "failed", "cancelled", "skipped"]);
export const ResearchStage = z.enum(["", "queries", "search", "read", "write", "save"]);
// full: 조사와 글쓰기 / collect: 자료 수집만 (shared) / write: 글쓰기만 (shared) / merge: 합친 글 (merged)
export const ResearchRunRole = z.enum(["full", "collect", "write", "merge"]);
export const ResearchRun = z.object({
  id: z.string(),
  researchId: z.string(),
  batchId: z.string(), // 한 번 실행 = 같은 batchId 의 실행 여러 개
  agentId: z.string(),
  role: ResearchRunRole,
  status: ResearchRunStatus,
  stage: ResearchStage,
  pages: z.number(),
  requests: z.number(),
  error: z.string(),
  result: z.string(),
  noteId: z.string(),
  changeId: z.string(),
  path: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type ResearchRun = z.infer<typeof ResearchRun>;

export const ResearchPageStatus = z.enum(["ok", "blocked", "robots", "denied", "error", "timeout"]);
export const ResearchPage = z.object({
  id: z.string(),
  runId: z.string(),
  url: z.string(),
  title: z.string(),
  depth: z.number(),
  status: ResearchPageStatus,
  relevant: z.boolean(),
  summary: z.string(),
  quotes: z.array(z.string()),
  fetchedAt: z.number(),
});
export type ResearchPage = z.infer<typeof ResearchPage>;
// 행동 로그 (P12a): 검색어·주소·제목·까닭뿐
export const ResearchEventKind = z.enum([
  "query",
  "search",
  "read",
  "skip",
  "follow",
  "login",
  "write",
  "save",
  "error",
]);
export const ResearchEvent = z.object({
  id: z.string(),
  runId: z.string(),
  at: z.number(),
  kind: ResearchEventKind,
  text: z.string(),
});
export type ResearchEvent = z.infer<typeof ResearchEvent>;
export const ResearchRunDetail = ResearchRun.extend({ pages: z.array(ResearchPage), events: z.array(ResearchEvent) });
export type ResearchRunDetail = z.infer<typeof ResearchRunDetail>;

// 리서치 화면의 대화 (P12d): 추가 지시로 실행, 결과로 이어서 대화
export const ResearchMessage = z.object({
  id: z.string(),
  researchId: z.string(),
  role: z.enum(["user", "agent"]),
  kind: z.enum(["instruction", "question", "answer"]),
  agentId: z.string(),
  text: z.string(),
  status: z.enum(["done", "streaming", "failed"]),
  at: z.number(),
});
export type ResearchMessage = z.infer<typeof ResearchMessage>;
export const ResearchTimeline = z.object({
  runs: z.array(ResearchRun),
  events: z.array(ResearchEvent),
  messages: z.array(ResearchMessage),
});
export type ResearchTimeline = z.infer<typeof ResearchTimeline>;
export const ResearchRunRequest = z.object({
  extra: z.string().trim().max(2000).default(""),
  continue: z.boolean().default(false), // 이어서 조사 (P12e): 지난 글을 바탕으로 새로 읽은 것을 더해 같은 글을 갱신
});
export const ResearchAskRequest = z.object({ text: z.string().trim().min(1).max(4000), agentId: z.string().min(1) });

export const Research = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  instruction: z.string(),
  agentIds: z.array(z.string()),
  mode: ResearchMode,
  scope: ResearchScope,
  output: ResearchOutput,
  schedule: TaskSchedule.nullable(),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
  lastRun: ResearchRun.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Research = z.infer<typeof Research>;

// ---- 에이전트별 사이트 계정 (P12c) ----

// 비밀번호는 받기만 한다. 응답 타입(SiteAccount)에는 없다
export const SiteAccountInput = z.object({
  domain,
  loginUrl: z
    .string()
    .trim()
    .regex(/^https?:\/\/\S+$/i, "로그인 주소는 https:// 로 시작"),
  username: z.string().trim().min(1, "아이디를 입력하세요").max(200),
  password: z.string().max(1000).default(""), // 고칠 때 비우면 그대로
});
export type SiteAccountInput = z.input<typeof SiteAccountInput>;

export const SiteAccountStatus = z.enum(["unknown", "ok", "failed", "needs_attention"]);
export const SiteAccountOutcome = z.enum([
  "ok",
  "no_form",
  "redirect_host",
  "captcha",
  "two_factor",
  "wrong_credentials",
  "no_password",
  "error",
]);
export type SiteAccountOutcome = z.infer<typeof SiteAccountOutcome>;
export const SiteAccount = z.object({
  id: z.string(),
  agentId: z.string(),
  domain: z.string(),
  loginUrl: z.string(),
  username: z.string(),
  status: SiteAccountStatus,
  lastError: z.string(),
  lastLoginAt: z.number().nullable(),
  hasSession: z.boolean(),
  createdAt: z.number(),
});
export type SiteAccount = z.infer<typeof SiteAccount>;
