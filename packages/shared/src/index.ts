// daemon ↔ web ↔ (이후) desktop_pet 사이의 API 계약.
import { z } from "zod";
import {
  BrowserStatus,
  DEFAULT_RESEARCH,
  ResearchEvent,
  ResearchMessage,
  ResearchRun,
  ResearchSettings,
  SiteAccount,
} from "./research";

export * from "./audit";
export * from "./commands";
export * from "./mcp";
export * from "./research";
export * from "./skills";
export * from "./tasks";

export const API_PREFIX = "/api";
export const SESSION_COOKIE = "proprix_session";
export const USAGE_URL = "https://chatgpt.com/settings/usage";

export const HealthResponse = z.object({
  ok: z.literal(true),
  name: z.literal("proprix"),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const SessionResponse = z.object({
  authenticated: z.literal(true),
  via: z.enum(["bearer", "cookie"]),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const ApiErrorCode = z.enum([
  "unauthorized",
  "forbidden_origin",
  "forbidden_host",
  "not_found",
  "bad_request",
  "conflict",
  "upstream", // SIWC·OpenAI 쪽 오류 (detail 에 code·recovery)
  "internal",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

// errors-and-recovery 분류 (@proprix/siwc 의 Recovery 와 같은 값)
export const Recovery = z.enum([
  "none",
  "retry_backoff",
  "re_sign_in",
  "usage_limit",
  "not_eligible",
  "restricted",
  "fix_request",
  "client_config",
  "network",
  "unknown",
]);
export type Recovery = z.infer<typeof Recovery>;

export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    detail: z.object({ code: z.string(), recovery: Recovery }).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

// ---- 계정 (SIWC) ----

export const AccountInfo = z.object({
  registered: z.boolean(), // 발급 client_id 보유
  signedIn: z.boolean(),
  planUsage: z.boolean(), // chatgpt.tokens.use.direct 범위
  email: z.string(),
  welcomeShown: z.boolean(), // 첫 로그인 안내("You're using your ChatGPT plan")를 봤는지
  mock: z.boolean(), // 모의 서버에 연결됨 (개발용)
});
export type AccountInfo = z.infer<typeof AccountInfo>;

export const SignInStart = z.object({ authorizeUrl: z.string() });
export type SignInStart = z.infer<typeof SignInStart>;

// 로그인 결과 코드: ok | cancelled | timeout | access_denied | invalid_callback | id_token_invalid | account_mismatch |
// port_in_use | listener_failed | token_exchange_failed 또는 OAuth error
export const SignInResult = z.object({ ok: z.boolean(), code: z.string() });
export type SignInResult = z.infer<typeof SignInResult>;

export const SignOutRequest = z.object({ forceLocal: z.boolean().default(false) });
export const SignOutResult = z.object({ ok: z.boolean(), code: z.string() }); // revoke_unconfirmed | revoke_failed

// efforts: 모델 목록이 알려 준 지원 추론 강도 (없으면 빈 배열 = 모두 보여 준다)
export const ModelInfo = z.object({
  slug: z.string(),
  displayName: z.string(),
  efforts: z.array(z.string()).default([]),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

// ---- LLM 게이트 ----

export const LlmStatus = z.object({
  paused: z.boolean(), // 사용량 한도로 새 요청 중지됨 (사용자가 재개해야 풀림)
  pausedCode: z.string(),
  active: z.number(),
  queued: z.number(),
});
export type LlmStatus = z.infer<typeof LlmStatus>;

// LLM 호출 기능 (사용량 장부·일일 예산 단위). preview(페르소나 미리보기)는 사용자가 직접 누를 때만이라 예산 밖
export const LlmFeature = z.enum([
  "chat",
  "router",
  "delegate",
  "debate",
  "lounge",
  "proactive",
  "memory",
  "summary",
  "tasks",
  "research",
  "preview",
]);
export type LlmFeature = z.infer<typeof LlmFeature>;

// 하루(로컬 자정 기준) 요청 수 상한. null = 무제한. 자동 기능만 기본 상한, 사용자 대화는 무제한 (사용자 결정 2026-10-28)
const DailyLimit = z.number().int().min(1).max(10_000).nullable();
export const Budgets = z.object({
  chat: DailyLimit, // 사용자가 보낸 메시지에 대한 응답 (도구 단계 포함)
  router: DailyLimit, // 그룹챗 화자 고르기
  delegate: DailyLimit, // 위임 받은 에이전트 실행
  debate: DailyLimit, // 토론·협업 발언
  lounge: DailyLimit, // 자율 대화
  proactive: DailyLimit, // 선제 메시지 (리마인더·체크인·안부)
  memory: DailyLimit, // 기억 추출·영어 정규화
  summary: DailyLimit, // 롤링 요약
  tasks: DailyLimit, // 반복 예약 작업 (실행 한 번에 도구 단계마다 1회)
  research: DailyLimit, // 자율 웹 리서치 (검색어·검색·페이지 요약·글쓰기마다 1회)
});
export type Budgets = z.infer<typeof Budgets>;
export type BudgetFeature = keyof Budgets;
export const DEFAULT_BUDGETS: Budgets = {
  chat: null,
  router: 200,
  delegate: 50,
  debate: 100,
  lounge: 30,
  proactive: 30,
  memory: 50,
  summary: 50,
  tasks: 100,
  research: 150,
};

export const BudgetUsage = z.object({
  feature: z.string(),
  used: z.number(), // 오늘 보낸 요청 수 (진행 중 포함)
  limit: z.number().nullable(),
});
export const UsageToday = z.object({ since: z.number(), features: z.array(BudgetUsage) });
export const BUDGET_FEATURES = Object.keys(DEFAULT_BUDGETS) as BudgetFeature[];

// 사용량 히트맵 (P10c): 로컬 날짜·기능별 요청 수. date = "YYYY-MM-DD"
export const UsageHistory = z.object({
  since: z.number(),
  days: z.array(z.object({ date: z.string(), feature: z.string(), count: z.number() })),
});
export type UsageHistory = z.infer<typeof UsageHistory>;
// 오늘 사용량이 예산의 80%·100% 에 닿는 순간 한 번 (사용자 결정 2026-10-29)
export const UsageAlert = z.object({
  feature: z.string(),
  used: z.number(),
  limit: z.number(),
  level: z.union([z.literal(80), z.literal(100)]),
});
export type UsageAlert = z.infer<typeof UsageAlert>;

// 자율 대화: 사용자 없이 에이전트끼리 '라운지' 방에서 잡담. 기본 꺼짐 (계획 결정)
export const LoungeSettings = z.object({
  enabled: z.boolean(),
  agentIds: z
    .array(z.string())
    .max(6)
    .refine((ids) => new Set(ids).size === ids.length, "같은 에이전트를 두 번 넣을 수 없다"),
  perDay: z.number().int().min(1).max(10), // 하루 세션 수 상한
  turns: z.number().int().min(2).max(20), // 세션당 발언 수
  startHour: z.number().int().min(0).max(23), // 이 시각부터
  endHour: z.number().int().min(1).max(24), // 이 시각 전까지만 시작
  extractMemories: z.boolean(), // 라운지 대화에서 기억 추출 (기본 끔)
});
export type LoungeSettings = z.infer<typeof LoungeSettings>;
export const DEFAULT_LOUNGE: LoungeSettings = {
  enabled: false,
  agentIds: [],
  perDay: 2,
  turns: 6,
  startHour: 9,
  endHour: 22,
  extractMemories: false,
};

// 기억 검색: 키워드(FTS5) + 선택한 로컬 임베딩 모델 하이브리드. 모델은 켤 때 내려받는다 (기본 꺼짐)
export const EmbeddingModelId = z.enum(["off", "embeddinggemma", "e5-small"]);
// autoExtract: 조용해지면 대화에서 기억을 자동 추출 (백그라운드 호출이라 동의해야 켜진다. 수동 추출은 별개)
export const MemorySettings = z.object({ embedding: EmbeddingModelId, autoExtract: z.boolean() });
export type MemorySettings = z.infer<typeof MemorySettings>;
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = { embedding: "off", autoExtract: false };

// off: 꺼짐 / loading: 내려받기·불러오는 중 / ready: 사용 중 / failed: 실패 → 키워드 검색만
export const EmbeddingStatus = z.object({
  model: EmbeddingModelId,
  state: z.enum(["off", "loading", "ready", "failed"]),
  error: z.string(),
  indexed: z.number(), // 벡터가 있는 활성 기억 수
  total: z.number(), // 활성 기억 수
});
export type EmbeddingStatus = z.infer<typeof EmbeddingStatus>;

// 선제 메시지: 방해 금지 시간대(이 시각부터 끝 시각 전까지, 자정을 넘을 수 있음)와 무응답 안부
export const ProactiveSettings = z.object({
  quietEnabled: z.boolean(),
  quietStart: z.number().int().min(0).max(23),
  quietEnd: z.number().int().min(0).max(23),
  nudgeEnabled: z.boolean(), // 무응답 안부 (기본 꺼짐)
  nudgeDays: z.number().int().min(1).max(30),
});
export type ProactiveSettings = z.infer<typeof ProactiveSettings>;
export const DEFAULT_PROACTIVE: ProactiveSettings = {
  quietEnabled: true,
  quietStart: 23,
  quietEnd: 8,
  nudgeEnabled: false,
  nudgeDays: 3,
};

// ---- 설정 ----

// 전역 지침: 모든 에이전트에게 늘 주는 사용자 지시 (라운지 제외 — 사용자 결정 2026-10-29)
export const GLOBAL_INSTRUCTIONS_MAX = 4000;
// 자동 백업: 하루 한 번 데이터 폴더의 backups/ 에 DB 사본 (최근 keep 개)
export const BackupSettings = z.object({ enabled: z.boolean(), keep: z.number().int().min(1).max(30) });
export type BackupSettings = z.infer<typeof BackupSettings>;
export const Settings = z.object({
  backup: BackupSettings,
  model: z.string(),
  instructions: z.string().max(GLOBAL_INSTRUCTIONS_MAX, `전역 지침은 ${GLOBAL_INSTRUCTIONS_MAX}자까지`),
  budgets: Budgets,
  lounge: LoungeSettings,
  memory: MemorySettings,
  proactive: ProactiveSettings,
  research: ResearchSettings,
  updateCheck: z.boolean(), // 새 버전 알림: GitHub 에 최신 버전을 묻는다
});
export type Settings = z.infer<typeof Settings>;
export const DEFAULT_BACKUP: BackupSettings = { enabled: true, keep: 7 };
export const SETTINGS_DEFAULTS: Settings = {
  backup: DEFAULT_BACKUP,
  model: "",
  instructions: "",
  budgets: DEFAULT_BUDGETS,
  lounge: DEFAULT_LOUNGE,
  memory: DEFAULT_MEMORY_SETTINGS,
  proactive: DEFAULT_PROACTIVE,
  research: DEFAULT_RESEARCH,
  updateCheck: true,
};
// budgets·lounge·memory 는 바꾼 항목만 보내면 기존 값에 합친다
export const SettingsPatch = z.object({
  backup: BackupSettings.partial().optional(),
  model: z.string().optional(),
  instructions: z.string().optional(),
  budgets: Budgets.partial().optional(),
  lounge: LoungeSettings.partial().optional(),
  memory: MemorySettings.partial().optional(),
  proactive: ProactiveSettings.partial().optional(),
  research: ResearchSettings.partial().optional(),
  updateCheck: z.boolean().optional(),
});
export const UpdateInfo = z.object({ latest: z.string().nullable() });
export type UpdateInfo = z.infer<typeof UpdateInfo>;

// ---- 페르소나 (성격·말투 템플릿) ----

export const PERSONA_BODY_MAX = 16_000; // desktop_pet persona.md 상한(16KB)과 맞춘다

const emoji = z
  .string()
  .trim()
  .min(1)
  .refine((s) => [...new Intl.Segmenter().segment(s)].length === 1, "이모지는 한 글자");
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "색은 #RRGGBB");

// 256px 로 줄인 이미지 data URL (png·jpeg·webp, 약 150KB 이하). 웹에서 줄여서 보낸다
export const AVATAR_IMAGE_MAX = 200_000;
const AvatarImage = z
  .string()
  .max(AVATAR_IMAGE_MAX, "이미지가 너무 큼")
  .regex(/^(?:data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2})?$/, "png·jpeg·webp 이미지만");

export const PersonaInput = z.object({
  name: z.string().trim().min(1).max(40),
  emoji,
  color,
  description: z.string().trim().max(200).default(""),
  body: z.string().max(PERSONA_BODY_MAX), // 성격·말투 (자유 형식 마크다운)
  petCharacterId: z.string().trim().max(64).default(""), // desktop_pet 캐릭터 id (P6)
  avatarImage: AvatarImage.default(""), // 이미지 아바타 ('' = 이모지+색)
});
export type PersonaInput = z.infer<typeof PersonaInput>;

export const Persona = PersonaInput.extend({
  id: z.string(),
  character: z.string().nullable(), // 표정 묶음의 버전 (없으면 null, 파일에서 읽는다)
  builtin: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Persona = z.infer<typeof Persona>;

// 표정 묶음 (docs/character-pack.md)
export const CHARACTER_FORMAT = "proprix-character";
export const CHARACTER_MANIFEST = "character.json";
export const CHARACTER_LIMITS = {
  zipBytes: 20 * 1024 * 1024,
  files: 64,
  totalBytes: 40 * 1024 * 1024, // 압축을 푼 전체
  fileBytes: 2 * 1024 * 1024, // 이미지 하나
  imagesBytes: 20 * 1024 * 1024, // 쓰는 이미지 전체
  frames: 8,
} as const;
const CharacterFile = z.string().min(1).max(200);
const CharacterFrames = z.union([CharacterFile, z.array(CharacterFile).min(1).max(CHARACTER_LIMITS.frames)]);
export const CharacterManifest = z.object({
  format: z.literal(CHARACTER_FORMAT),
  version: z.literal(1),
  kind: z.literal("expressions"),
  thumbnail: CharacterFile.optional(),
  expressions: z
    .object({
      idle: CharacterFrames,
      blink: CharacterFrames.optional(),
      thinking: CharacterFrames.optional(),
      working: CharacterFrames.optional(),
      waiting: CharacterFrames.optional(),
      blocked: CharacterFrames.optional(),
      done: CharacterFrames.optional(),
      talking: CharacterFrames.optional(),
    })
    .strict(),
});
export const CharacterPack = z.object({
  version: z.string(),
  thumbnail: z.string(), // data URL ('' = 없음)
  expressions: z.record(z.string(), z.array(z.string())), // 표정 → data URL 들
});
export type CharacterPack = z.infer<typeof CharacterPack>;

// 테마 묶음 (docs/theme-pack.md)
export const THEME_FORMAT = "proprix-theme";
export const THEME_MANIFEST = "theme.json";
export const THEME_LIMITS = {
  zipBytes: 30 * 1024 * 1024,
  files: 800,
  totalBytes: 60 * 1024 * 1024, // 압축을 푼 전체
  fileBytes: 5 * 1024 * 1024,
} as const;
const ThemePath = z.string().min(1).max(200);
export const ThemeManifest = z.object({
  format: z.literal(THEME_FORMAT),
  version: z.literal(1),
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "영문 소문자·숫자·- 만 쓸 수 있습니다")
    .refine((id) => id !== "studio", "기본 테마의 id 는 쓸 수 없습니다"),
  name: z.string().trim().min(1).max(60),
  notice: z.string().trim().max(200).default(""),
  css: ThemePath,
  fontCss: ThemePath.optional(),
  stage: z.enum(["board", "court"]).default("board"), // 토론 화면
  labels: z.record(z.string().max(40), z.string().trim().min(1).max(30)).default({}), // 화면 이름 바꾸기 (docs/theme-pack.md)
});
export const ThemeInfo = z.object({
  id: z.string(),
  name: z.string(),
  notice: z.string(), // 켠 동안 앱 아래에 항상 보이는 안내
  stage: z.enum(["board", "court"]),
  labels: z.record(z.string(), z.string()),
  version: z.string(),
});
export type ThemeInfo = z.infer<typeof ThemeInfo>;
export const ThemeBundle = ThemeInfo.extend({
  css: z.string(),
  fontCss: z.string(), // 글꼴: 커서 기기에 기억하지 않는다
});
export type ThemeBundle = z.infer<typeof ThemeBundle>;

// 내보내기 파일 (JSON)
export const PERSONA_EXPORT_FORMAT = "proprix.persona";
export const PersonaExport = z.object({
  format: z.literal(PERSONA_EXPORT_FORMAT),
  version: z.literal(1),
  persona: PersonaInput,
});
export type PersonaExport = z.infer<typeof PersonaExport>;

export const PersonaImportRequest = z.discriminatedUnion("format", [
  z.object({ format: z.literal("json"), data: z.unknown() }),
  // desktop_pet persona.md: 본문만. 이름이 없으면 본문의 "이름:" 줄에서 찾는다
  z.object({
    format: z.literal("markdown"),
    text: z.string().max(PERSONA_BODY_MAX),
    name: z.string().trim().max(40).optional(),
  }),
]);

// ---- 도구 ----

// read: 바로 실행 / write: 실행 전 사용자 확인 (에이전트가 '항상 허용'이면 자동)
export const ToolKind = z.enum(["read", "write"]);
export const ToolInfo = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  kind: ToolKind,
  // 방에 있어야 보이는 것: workspace = 작업 폴더, shell = 작업 폴더 + 명령 실행 켜짐
  // skill = 이 실행에서 쓸 수 있는 skill 이 있을 때 (에이전트 편집기의 도구 목록에는 보이지 않는다)
  requires: z.enum(["", "workspace", "shell", "skill"]).optional(),
  // 항상 허용·trusted 와 관계없이 늘 확인 (명령 실행)
  alwaysConfirm: z.boolean().optional(),
});
export type ToolInfo = z.infer<typeof ToolInfo>;

// 새 에이전트의 기본 도구: 로컬 도구 전부 (쓰기는 확인을 받으므로) + 위임 (사용자 결정 2026-10-28)
export const DEFAULT_AGENT_TOOLS = [
  "current_time",
  "note_search",
  "note_create",
  "note_update",
  "note_delete",
  "memory_search",
  "memory_save",
  "memory_forget",
  "delegate_to_agent",
  "reminder_create",
  "reminder_list",
  "reminder_cancel",
  "task_create",
  "task_list",
  "task_delete",
  "run_workers",
  "show_visual",
];

// 에이전트 간 위임 도구 (실행은 채팅 루프가 맡는다)
export const DELEGATE_TOOL = "delegate_to_agent";
// 임시 작업자 (P9a): 에이전트가 일회용 작업자를 동시에 띄워 결과만 받는다. WORKER_CALL = 작업자 하나의 기록 행
export const WORKERS_TOOL = "run_workers";
// 대화 중 시각화: 에이전트가 낸 SVG·HTML 을 답 안에 그린다 (sandbox iframe, 스크립트 O · 네트워크 X — 사용자 결정 2026-10-30)
export const VISUAL_TOOL = "show_visual";
export const VISUAL_CONTENT_MAX = 100_000;
export const WORKER_CALL = "worker";
export const MAX_WORKERS = 4;
export const MAX_DELEGATION_DEPTH = 2; // A→B→C 까지

// pending: 확인 대기 / running / done / failed / denied: 거부·시간 초과·중지
export const ToolCallStatus = z.enum(["pending", "running", "done", "failed", "denied"]);
export const ToolCall = z.object({
  id: z.string(),
  roomId: z.string(),
  messageId: z.string(), // 이 호출이 일어난 assistant 메시지
  agentId: z.string(), // 호출한 에이전트
  parentId: z.string(), // 위임 안에서 일어난 호출이면 그 위임 호출 id ("" = 최상위)
  name: z.string(),
  args: z.string(), // 모델이 보낸 JSON 문자열 (확인 카드에 그대로 보여 준다)
  kind: ToolKind,
  status: ToolCallStatus,
  output: z.string(), // 모델에 돌려준 결과 (잘라낸 것)
  reason: z.string(), // denied·failed 사유
  preview: z.string().default(""), // 승인 카드 미리보기 (파일 diff · 명령 요약)
  createdAt: z.number(),
});
export type ToolCall = z.infer<typeof ToolCall>;

// 작업 폴더 파일 변경 기록 (되돌리기)
export const FileChange = z.object({
  id: z.string(),
  callId: z.string(),
  roomId: z.string(),
  path: z.string(),
  op: z.enum(["write", "edit", "delete"]),
  size: z.number(),
  createdAt: z.number(),
  restoredAt: z.number().nullable(),
});
export type FileChange = z.infer<typeof FileChange>;
export const RestoreRequest = z.object({ force: z.boolean().default(false) });

// 도구 실행 감사 로그 (P10b): 모든 방의 쓰기 도구 호출. 도구가 만든 메모·리마인더는 지우거나 취소해 되돌린다
export const AuditUndo = z.object({
  kind: z.enum(["note", "reminder"]),
  targetId: z.string(),
  label: z.string(), // 지금 메모 제목·리마인더 내용 ("" = 이미 없음)
  available: z.boolean(), // 아직 되돌릴 수 있다 (메모가 남아 있음·리마인더가 예약 상태)
});
export type AuditUndo = z.infer<typeof AuditUndo>;
export const AuditEntry = ToolCall.extend({
  roomTitle: z.string(),
  undoneAt: z.number().nullable(), // 감사 화면에서 되돌린 시각
  changes: z.array(FileChange), // 이 호출의 파일 변경 (되돌리기는 /file-changes/:id/restore)
  undo: AuditUndo.nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
export const AuditPage = z.object({ items: z.array(AuditEntry), next: z.string().nullable() });
export type AuditPage = z.infer<typeof AuditPage>;
// 사용자가 작업 폴더에 직접 저장 (토론·협업 산출물). 기록은 "artifact:<messageId>" 로 그 메시지에 묶는다
export const SaveFileRequest = z.object({
  path: z.string().trim().min(1).max(500),
  content: z.string().max(5 * 1024 * 1024),
  messageId: z.string().max(64).default(""),
  overwrite: z.boolean().default(false), // 같은 이름의 파일이 있으면 덮어쓴다 (원본은 보관돼 되돌릴 수 있음)
});
export type SaveFileRequest = z.infer<typeof SaveFileRequest>;
// 명령 실행의 한계 (승인 카드·폴더 대화상자에 그대로 보인다 — daemon exec-policy 와 같은 말)
export const SHELL_LIMITS =
  "명령은 작업 폴더에서 시작하지만 폴더 밖 파일 읽기·쓰기, 네트워크 접근, 다른 프로그램 실행, 시스템 설정 변경을 막지 못합니다. 승인한 명령은 이 컴퓨터에서 사용자 권한으로 실행되며, 명령으로 바뀐 파일은 되돌릴 수 없습니다.";
export const SnapshotUsage = z.object({ bytes: z.number(), count: z.number() });
// always: 허용하면서 이 호출을 한 에이전트의 이 도구를 앞으로 확인 없이 (웹 검색·토론·명령 출력이 섞인 턴은 계속 확인, 작업 폴더 파일을 읽은 턴은 폴더 밖 쓰기만 확인)
export const ToolDecisionRequest = z.object({ approve: z.boolean(), always: z.boolean().default(false) });
// '항상 허용' 해제
export const RevokeToolRequest = z.object({ tool: z.string().min(1).max(64) });

// ---- 메모 (도구가 쓰는 로컬 노트) ----

export const NoteInput = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(""),
});
export type NoteInput = z.infer<typeof NoteInput>;
export const Note = NoteInput.extend({
  id: z.string(),
  agentId: z.string(), // 만든 에이전트 ("" = 사용자가 직접)
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Note = z.infer<typeof Note>;

// ---- 장기 메모리 ----

// 범위: "shared" = 모든 에이전트가 보는 공용, 그 밖에는 에이전트 id (그 에이전트만)
export const SHARED_SCOPE = "shared";
export const MemoryKind = z.enum(["fact", "preference", "event", "relationship"]);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const MemoryInput = z.object({
  scope: z.string().min(1).max(64),
  kind: MemoryKind,
  content: z.string().trim().min(1).max(500), // 원문 언어 (UI·검색)
  contentEn: z.string().trim().max(800).default(""), // 영어 정규화본 (요청 주입). "" = 아직 없음 → 원문을 쓴다
  importance: z.number().int().min(1).max(5).default(3),
  validUntil: z.number().nullable().default(null), // 지나면 쓰지 않는다 (일정·일시적 사실)
});
export type MemoryInput = z.infer<typeof MemoryInput>;

// ---- 기억 관리 (P10e) ----
// 이 기억을 참고로 넣은 답변 (실제로 반영했는지는 알 수 없다 — '참고한 답변')
export const MemoryUse = z.object({
  messageId: z.string(),
  roomId: z.string(),
  roomTitle: z.string(),
  agentId: z.string(),
  createdAt: z.number(),
  excerpt: z.string(),
});
export type MemoryUse = z.infer<typeof MemoryUse>;
export const MemoryUses = z.object({ total: z.number(), items: z.array(MemoryUse) });
export const MemoryBulkRequest = z.object({
  ids: z.array(z.string()).min(1).max(500),
  set: z
    .object({
      scope: z.string().min(1).optional(),
      kind: MemoryKind.optional(),
      importance: z.number().int().min(1).max(5).optional(),
    })
    .optional(),
  delete: z.boolean().default(false),
});
export type MemoryBulkRequest = z.infer<typeof MemoryBulkRequest>;
// 병합: 새 기억을 만들고 원본은 대체됨으로 (이력 유지 — 사용자 결정 2026-10-29)
export const MemoryMergeRequest = z.object({ ids: z.array(z.string()).min(2).max(50), memory: MemoryInput });
export const MemoryEdge = z.object({
  a: z.string(),
  b: z.string(),
  kind: z.enum(["similar", "co_used"]),
  weight: z.number(), // similar: 코사인(임베딩) 또는 순위 점수(키워드), co_used: 함께 넣은 답변 수
});
export type MemoryEdge = z.infer<typeof MemoryEdge>;
export const MemoryGraph = z.object({ similarity: z.enum(["embedding", "keyword"]), edges: z.array(MemoryEdge) });
export type MemoryGraph = z.infer<typeof MemoryGraph>;

export const Memory = MemoryInput.extend({
  id: z.string(),
  supersededBy: z.string().nullable(), // 바뀐 선호 등으로 대체됨 (이력으로만 남음)
  sourceRoomId: z.string(),
  sourceMessageId: z.string().default(""), // P10e 부터: 기억이 나온 메시지 ("" = 대화로만 이동)
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().nullable(),
});
export type Memory = z.infer<typeof Memory>;

export const ExtractResult = z.object({ saved: z.number(), superseded: z.number(), skipped: z.string() });

// ---- 에이전트 (역할: 페르소나 + 역할 지시문 + 모델 + 도구) ----

// 정기 체크인: 정한 요일·시각에 에이전트가 먼저 말을 건다 (그 에이전트 혼자 있는 최근 방에)
export const Checkin = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "시각은 HH:MM"),
  days: z.array(z.number().int().min(0).max(6)).max(7), // 0 = 일요일
});
export type Checkin = z.infer<typeof Checkin>;
export const DEFAULT_CHECKIN: Checkin = { enabled: false, time: "09:00", days: [0, 1, 2, 3, 4, 5, 6] };

// 에이전트별 추론 강도 (reasoning.effort). "" = 자동 (보내지 않고 모델 기본값)
export const AGENT_EFFORTS = ["", "low", "medium", "high", "xhigh"] as const;
export const AgentEffort = z.enum(AGENT_EFFORTS);
export type AgentEffort = z.infer<typeof AgentEffort>;

export const AgentInput = z.object({
  personaId: z.string().min(1),
  name: z.string().trim().min(1).max(40),
  role: z.string().max(4000).default(""), // 사용자가 쓰는 역할 지시문
  model: z.string().max(100).default(""), // 비면 전역 기본 모델
  tools: z.array(z.string().max(64)).max(50).default(DEFAULT_AGENT_TOOLS), // 허용 도구 이름
  autoApproveWrites: z.boolean().default(false), // 쓰기 도구 '항상 허용' (웹 검색이 들어간 턴에서는 무시)
  webSearch: z.boolean().default(false), // OpenAI 호스티드 웹 검색 (검색어가 밖으로 나감)
  memoryIsolated: z.boolean().default(false), // 격리: 공용 메모리는 읽기만, 새 기억은 이 에이전트 범위에만
  checkin: Checkin.default(DEFAULT_CHECKIN), // 정기 체크인 (선제 메시지)
  reasoningEffort: AgentEffort.default(""), // 이 에이전트의 모든 요청 (대화·토론·라운지·선제·위임)
  skills: z.array(z.string().max(64)).max(50).default([]), // 쓰는 skill 이름 (새 skill 은 아무도 쓰지 않음)
  mcpServers: z.array(z.string().max(64)).max(50).default([]), // 쓰는 MCP 서버 id (새 서버는 아무도 쓰지 않음)
});
export type AgentInput = z.infer<typeof AgentInput>;

export const Agent = AgentInput.extend({
  // 승인 카드에서 '항상 허용'한 도구 (이 에이전트만). 편집기 저장(AgentInput)으로는 바뀌지 않는다
  autoApproveTools: z.array(z.string()),
  id: z.string(),
  builtin: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Agent = z.infer<typeof Agent>;

// 저장하지 않은 페르소나·역할로 한 번 대화해 본다 (이력·메모리 없음)
export const PreviewRequest = z.object({
  persona: PersonaInput,
  name: z.string().trim().min(1).max(40),
  role: z.string().max(4000).default(""),
  text: z.string().trim().min(1).max(2000),
  model: z.string().min(1),
});
export const PreviewResponse = z.object({
  text: z.string(),
  outcome: z.string(),
  code: z.string(),
  recovery: Recovery,
});

// ---- 채팅 ----

export const MAX_ROOM_AGENTS = 8;
export const ChainLimit = z.number().int().min(1).max(5); // 사용자 발화 1회당 에이전트 연쇄 응답 상한

// 작업 폴더에 사용자가 더하는 규칙 (glob). 기본 규칙(비밀·키·.git 등)은 끌 수 없다
export const WorkspaceRules = z.object({
  deny: z.array(z.string().trim().min(1).max(200)).max(100), // 읽기·쓰기 모두 막음
  readonly: z.array(z.string().trim().min(1).max(200)).max(100), // 쓰기·지우기만 막음
});
export type WorkspaceRules = z.infer<typeof WorkspaceRules>;

export const Room = z.object({
  id: z.string(),
  title: z.string(),
  agentIds: z.array(z.string()), // 참여 에이전트 (2명 이상이면 그룹챗)
  chainLimit: ChainLimit,
  kind: z.enum(["chat", "lounge"]), // lounge = 자율 대화가 쌓이는 방
  running: z.boolean(), // 응답(연쇄) 진행 중
  pinned: z.boolean(), // 목록 맨 위
  archived: z.boolean(), // 목록에서 숨김 (보관함)
  workspace: z.string(), // 작업 폴더 절대 경로 ("" = 없음)
  workspaceRules: WorkspaceRules,
  shellEnabled: z.boolean(), // 이 방에서 명령 실행 허용 (작업 폴더가 있어도 기본 꺼짐)
  // 서브 채팅 (P9b): 부모 방·분기 메시지·만들 때의 부모 제목 ("" = 일반 방). 참조 사본은 /rooms/:id/reference
  parentRoomId: z.string(),
  parentMessageId: z.string(),
  parentTitle: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Room = z.infer<typeof Room>;

export const CreateSubchatRequest = z.object({
  messageId: z.string().optional(), // 없으면 지금 마지막 메시지에서 분기
  agentIds: z.array(z.string()).min(1).max(8).optional(), // 없으면 부모와 같게
  title: z.string().trim().min(1).max(100).optional(),
});
export const SUBCHAT_REFERENCE_MAX = 40_000;

export const RoomSummary = z.object({
  roomId: z.string(),
  summary: z.string(), // 오래된 대화의 영어 요약 (요청 instructions 에 들어감)
  coveredUntil: z.number(), // 이 시각(createdAt)까지의 메시지가 요약에 포함됨
  updatedAt: z.number(),
});
export type RoomSummary = z.infer<typeof RoomSummary>;

// streaming: 받는 중 / complete / partial: 중지·한도로 일부만 / failed
export const MessageStatus = z.enum(["streaming", "complete", "partial", "failed"]);
export type MessageStatus = z.infer<typeof MessageStatus>;

// ---- 첨부 (사용자 결정 2026-10-29: 이미지 + 텍스트 + PDF) ----
// 이미지는 웹에서 줄인 data URL 을 모델에 그대로, 텍스트·PDF 는 (웹에서 뽑은) 글자를 메시지에 붙여 보낸다
export const MAX_ATTACHMENTS = 6;
export const ATTACHMENT_IMAGE_MAX = 2_000_000; // data URL 글자 수
export const ATTACHMENT_TEXT_MAX = 200_000;
const attachmentName = z.string().trim().min(1).max(200);
const attachmentSize = z.number().int().min(0).max(100_000_000);
export const AttachmentInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image"),
    name: attachmentName,
    mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    size: attachmentSize,
    data: z
      .string()
      .max(ATTACHMENT_IMAGE_MAX, "이미지가 너무 큼")
      .regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/, "이미지 형식이 아님"),
  }),
  z.object({
    kind: z.literal("text"),
    name: attachmentName,
    mime: z.string().max(100),
    size: attachmentSize,
    data: z.string().max(ATTACHMENT_TEXT_MAX, "파일 내용이 너무 김"),
  }),
]);
export type AttachmentInput = z.infer<typeof AttachmentInput>;
// 메시지에 붙는 첨부. 이미지는 data 까지 (앱은 <img> 요청에 토큰을 붙일 수 없어서), 텍스트는 "" (열 때 따로 받는다)
export const Attachment = z.object({
  id: z.string(),
  kind: z.enum(["image", "text"]),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  data: z.string(),
});
export type Attachment = z.infer<typeof Attachment>;
export const AttachmentContent = z.object({ id: z.string(), name: z.string(), data: z.string() });

export const Message = z.object({
  id: z.string(),
  roomId: z.string(),
  role: z.enum(["user", "assistant"]),
  agentId: z.string(), // assistant 의 화자. user 는 ""
  content: z.string(),
  status: MessageStatus,
  model: z.string(),
  errorCode: z.string(), // failed·partial 의 사유 (예: subscription_sharing_usage_limit_exceeded)
  recovery: Recovery,
  sources: z.array(z.object({ url: z.string(), title: z.string() })), // 웹 검색 출처
  memoryIds: z.array(z.string()), // 이 응답을 만들 때 참고한 기억
  debateId: z.string(), // 토론·협업 중의 발언이면 그 토론 id ("" = 일반 대화)
  debateRound: z.number(), // 0 = 주제·여는 말, 1..rounds, rounds + 1 = 맺는 말
  proactive: z.enum(["", "reminder", "checkin", "nudge", "task"]), // 에이전트가 먼저 보낸 메시지
  attachments: z.array(Attachment).default([]),
  createdAt: z.number(),
});
export type Message = z.infer<typeof Message>;

// ---- 토론·협업 ----

// debate: 서로 반박·검증하고 진행자가 결론 / collab: 앞 발언을 보완해 산출물을 만들고 진행자가 최종본 정리
export const DebateMode = z.enum(["debate", "collab"]);
export type DebateMode = z.infer<typeof DebateMode>;
// stopped: 사용자가 중지·daemon 재시작 / failed: 한도·오류로 끝까지 못 감
export const DebateStatus = z.enum(["running", "done", "stopped", "failed"]);
export const MAX_DEBATE_AGENTS = 6;
export const MAX_DEBATE_ROUNDS = 5;

export const Debate = z.object({
  id: z.string(),
  roomId: z.string(),
  mode: DebateMode,
  topic: z.string(),
  agentIds: z.array(z.string()), // 참가자 (발언 순서)
  moderatorId: z.string(), // 진행자 (참가자가 아니어도 된다)
  rounds: z.number(),
  round: z.number(), // 진행 위치
  status: DebateStatus,
  errorCode: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Debate = z.infer<typeof Debate>;

// 참가자는 방 참여자 중에서 (토론 뒤 같은 방에서 @이름으로 이어 물을 수 있게), 진행자는 아무 에이전트
export const StartDebateRequest = z.object({
  mode: DebateMode.default("debate"),
  topic: z.string().trim().min(1).max(2000),
  agentIds: z
    .array(z.string())
    .min(2)
    .max(MAX_DEBATE_AGENTS)
    .refine((ids) => new Set(ids).size === ids.length, "같은 에이전트를 두 번 넣을 수 없다"),
  moderatorId: z.string().min(1),
  rounds: z.number().int().min(1).max(MAX_DEBATE_ROUNDS).default(2),
  // /debate·/collab 으로 연 토론: 방 밖 에이전트도 참가하고, 이 대화의 기억·도구 작업을 모두에게 넘긴다 (방 구성은 그대로)
  context: z.boolean().optional(),
  model: z.string().min(1), // 전역 기본 모델 (에이전트 지정 모델이 우선)
});
export type StartDebateRequest = z.infer<typeof StartDebateRequest>;

const RoomAgentIds = z
  .array(z.string())
  .min(1)
  .max(MAX_ROOM_AGENTS)
  .refine((ids) => new Set(ids).size === ids.length, "같은 에이전트를 두 번 넣을 수 없다");
export const CreateRoomRequest = z.object({
  title: z.string().trim().min(1).max(100).default("새 채팅"),
  agentIds: RoomAgentIds.optional(), // 없으면 기본 에이전트
  chainLimit: ChainLimit.default(3),
});
// 에이전트 팀 프리셋 (P10d): 기존 에이전트 묶음만 (역할·도구는 각 에이전트 설정 — 사용자 결정 2026-10-29)
export const MIN_TEAM_AGENTS = 2;
export const teamKey = (name: string) => name.trim().toLowerCase();
export const TeamInput = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).default(""),
  agentIds: RoomAgentIds.refine((ids) => ids.length >= MIN_TEAM_AGENTS, "팀은 에이전트가 2명 이상이어야 한다"),
  chainLimit: ChainLimit.default(3),
});
export type TeamInput = z.infer<typeof TeamInput>;
export const Team = TeamInput.extend({
  id: z.string(),
  agentIds: z.array(z.string()), // 에이전트를 지우면 빠져 2명 미만일 수 있다 ('참가자 부족')
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Team = z.infer<typeof Team>;

export const UpdateRoomRequest = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  agentIds: RoomAgentIds.optional(),
  chainLimit: ChainLimit.optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  workspace: z.string().max(260).optional(), // "" = 해제
  workspaceRules: WorkspaceRules.optional(),
  shellEnabled: z.boolean().optional(),
});
export const SendMessageRequest = z
  .object({
    text: z.string().trim().max(20_000).default(""),
    model: z.string().min(1), // 전역 기본 모델 (에이전트에 모델이 지정돼 있으면 그쪽이 우선)
    attachments: z.array(AttachmentInput).max(MAX_ATTACHMENTS).default([]),
  })
  .refine((r) => r.text !== "" || r.attachments.length > 0, "메시지나 첨부가 필요함");
// 응답 메시지는 화자가 정해질 때마다 WebSocket "message" 이벤트로 온다 (그룹챗은 라우터를 거친 뒤)
export const SendMessageResponse = z.object({ user: Message });
// 수정해서 다시 보내기 (text 있음) · 답 다시 받기 (text 없음, 메시지가 답이면 그 앞 사용자 메시지부터). 뒤 대화는 지워진다
export const RewindRequest = z.object({
  text: z.string().trim().min(1).max(20_000).optional(),
  model: z.string().min(1),
});

// ---- 대화 검색 (검색 화면) ----
export const SearchResult = z.object({
  messageId: z.string(),
  roomId: z.string(),
  roomTitle: z.string(),
  role: z.enum(["user", "assistant"]),
  agentId: z.string(),
  snippet: z.string(), // 찾은 곳 앞뒤 글자
  createdAt: z.number(),
});
export type SearchResult = z.infer<typeof SearchResult>;
export const SearchResponse = z.object({ results: z.array(SearchResult), more: z.boolean() });

// ---- 시각화 (show_visual) ----
// 문서 CSP: 모든 네트워크를 막는다. 앱 창과 daemon 응답이 같은 값을 쓴다
export const VISUAL_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; " +
  "font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";
export const VisualFrameRequest = z.object({ doc: z.string().max(8_000_000) });
export const VisualFrameResponse = z.object({ id: z.string() });

// ---- 백업 ----
export const BackupItem = z.object({ name: z.string(), size: z.number(), at: z.number() });
export const BEFORE_RESTORE = "before-restore"; // 복구 직전 상태의 이름 (되돌리기)
export const BackupRestoreRequest = z.object({ name: z.string() });
export const RestoreOutcome = z.object({ ok: z.boolean(), name: z.string(), at: z.number(), error: z.string() });
export const RestoreState = z.object({
  pending: z.string().nullable(),
  before: z.object({ at: z.number(), from: z.string() }).nullable(),
  result: RestoreOutcome.nullable(),
});
export const BackupInfo = z.object({ dir: z.string(), items: z.array(BackupItem), restore: RestoreState });

// ---- 에이전트 상태 (화면의 점·한 줄·아바타 애니메이션) ----

// idle 대기 / thinking 생각 중 / working 답하는 중·도구 실행·위임 / waiting 확인 필요 / blocked 한도·오류 / done 방금 끝냄
export const AgentState = z.enum(["idle", "thinking", "working", "waiting", "blocked", "done"]);
export type AgentState = z.infer<typeof AgentState>;
export const AgentStatus = z.object({
  agentId: z.string(),
  state: AgentState,
  text: z.string(), // 사람이 읽는 한 줄 (예: "확인 필요 · 메모 저장")
  roomId: z.string(), // 이 상태가 일어난 방 ("" = 없음)
  debate: z.boolean().default(false), // 토론·협업 진행 중인 방의 상태 (작업실의 칸)
  at: z.number(),
});
export type AgentStatus = z.infer<typeof AgentStatus>;

// ---- 리마인더 ----

export const ReminderRepeat = z.enum(["none", "daily", "weekdays", "weekly"]);
export const Reminder = z.object({
  id: z.string(),
  roomId: z.string(),
  agentId: z.string(),
  text: z.string(),
  dueAt: z.number(), // 다음에 보낼 시각
  repeat: ReminderRepeat,
  status: z.enum(["scheduled", "done", "cancelled"]),
  firedCount: z.number(),
  lastFiredAt: z.number().nullable(),
  createdAt: z.number(),
});
export type Reminder = z.infer<typeof Reminder>;

// ---- 자율 대화 (라운지) ----

export const LoungeSession = z.object({
  id: z.string(),
  roomId: z.string(),
  agentIds: z.array(z.string()),
  turns: z.number(),
  spoken: z.number(),
  manual: z.boolean(),
  status: z.enum(["running", "done", "stopped", "failed"]),
  errorCode: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type LoungeSession = z.infer<typeof LoungeSession>;
export const LoungeStatus = z.object({
  roomId: z.string(), // 라운지 방 ("" = 아직 없음)
  sessionsToday: z.number(), // 오늘 자동으로 시작한 세션 수 ('지금 실행' 제외)
  recent: z.array(LoungeSession),
});
export const LoungeRunRequest = z.object({ model: z.string().min(1) });

// ---- WebSocket ----

export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), version: z.string() }),
  z.object({ type: z.literal("pong"), at: z.number() }),
  z.object({ type: z.literal("account"), account: AccountInfo, signIn: SignInResult.optional() }),
  z.object({ type: z.literal("llm"), status: LlmStatus }),
  z.object({ type: z.literal("usage_alert"), alert: UsageAlert }), // 일일 예산의 80%·100% 에 닿음
  z.object({ type: z.literal("message"), message: Message }), // 새 메시지 또는 상태 변경
  z.object({ type: z.literal("messages_removed"), roomId: z.string(), ids: z.array(z.string()) }), // 다시 받기·수정으로 지움
  z.object({ type: z.literal("delta"), roomId: z.string(), messageId: z.string(), text: z.string() }),
  z.object({ type: z.literal("turn"), roomId: z.string(), running: z.boolean() }), // 응답 연쇄 시작·끝
  z.object({ type: z.literal("debate"), debate: Debate }), // 토론 시작·진행·끝
  z.object({ type: z.literal("lounge"), session: LoungeSession }), // 자율 대화 세션 시작·진행·끝
  z.object({ type: z.literal("file_changes"), roomId: z.string() }), // 작업 폴더 파일이 바뀌거나 되돌려짐
  z.object({ type: z.literal("agents") }), // 에이전트가 바뀜 ('항상 허용' 규칙 등 — 목록을 다시 불러온다)
  z.object({ type: z.literal("rooms") }), // 방 목록이 바뀜 (라운지 방 생성 등)
  z.object({ type: z.literal("reminders") }), // 리마인더가 바뀜 (목록을 다시 불러온다)
  z.object({ type: z.literal("agent_status"), status: AgentStatus }), // 에이전트 상태가 바뀜
  z.object({ type: z.literal("summary"), summary: RoomSummary }),
  z.object({ type: z.literal("tool"), call: ToolCall }), // 새 도구 호출 또는 상태 변경
  z.object({ type: z.literal("notes") }), // 메모가 바뀜 (목록을 다시 불러온다)
  z.object({ type: z.literal("commands") }), // 사용자 정의 / 명령이 바뀜
  z.object({ type: z.literal("teams") }), // 팀 프리셋이 바뀜
  z.object({ type: z.literal("skills") }), // skill 이 설치·업데이트·삭제됨
  z.object({ type: z.literal("mcp") }), // MCP 서버·도구·연결 상태가 바뀜
  z.object({ type: z.literal("tasks") }), // 예약 작업·실행 기록이 바뀜
  z.object({ type: z.literal("memories") }), // 기억이 바뀜
  z.object({ type: z.literal("embedding"), status: EmbeddingStatus }), // 로컬 임베딩 상태
  z.object({ type: z.literal("research_browser"), status: BrowserStatus }), // 리서치 브라우저 설치 상태
  z.object({ type: z.literal("research") }), // 리서치 목록이 바뀜
  z.object({ type: z.literal("research_run"), run: ResearchRun }), // 리서치 실행 진행 (단계·페이지 수·결과)
  z.object({ type: z.literal("research_event"), researchId: z.string(), event: ResearchEvent }), // 행동 로그 한 줄 (P12a)
  z.object({ type: z.literal("research_message"), message: ResearchMessage }), // 리서치 화면의 대화 (P12d, 답은 쓰는 중에도 온다)
  z.object({ type: z.literal("site_account"), account: SiteAccount }), // 사이트 계정 상태 변경 (P12c, 비밀번호 없음)
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export const ClientEvent = z.discriminatedUnion("type", [z.object({ type: z.literal("ping") })]);
export type ClientEvent = z.infer<typeof ClientEvent>;
