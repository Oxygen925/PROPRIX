// MCP (P7d): Tools 만. 서버별 신뢰 정책·도구별 켜기(정의 고정)·필요할 때 연결
import { z } from "zod";

// 서버 이름 = 도구 이름 앞부분 (mcp__<name>__<tool>, 64자 안에 들어가게 20자까지). 만든 뒤 바꾸지 않는다
export const MCP_SERVER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;
export const MCP_PREFIX = "mcp__";

export const McpTrust = z.enum(["ask", "readonly-auto"]);
export type McpTrust = z.infer<typeof McpTrust>;
export const McpTransport = z.enum(["stdio", "http"]);

/** http 는 https 만, 이 PC(loopback) 는 http 도 */
export function mcpUrlError(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "주소 형식이 아닙니다";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return "";
  return "https 주소만 쓸 수 있습니다 (이 PC 의 localhost 는 http 도 가능)";
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY = /^[A-Za-z0-9-]+$/;

// 저장 요청. env·headers 의 값이 "" 이면 (수정할 때) 저장된 값을 그대로 둔다. 목록에서 뺀 키는 지운다
export const McpServerInput = z
  .object({
    name: z.string().trim().regex(MCP_SERVER_NAME, "이름은 영문으로 시작하는 1~20자 (영문·숫자·-·_)"),
    transport: McpTransport,
    command: z.string().trim().max(260).default(""),
    args: z.array(z.string().max(2000)).max(50).default([]),
    env: z.record(z.string().regex(ENV_KEY, "환경 변수 이름 형식"), z.string().max(8000)).default({}),
    url: z.string().trim().max(2000).default(""),
    headers: z.record(z.string().regex(HEADER_KEY, "헤더 이름 형식"), z.string().max(8000)).default({}),
    trust: McpTrust.default("ask"),
    enabled: z.boolean().default(true),
  })
  .superRefine((s, ctx) => {
    if (s.transport === "stdio" && !s.command)
      ctx.addIssue({ code: "custom", path: ["command"], message: "실행할 명령이 필요합니다" });
    if (s.transport === "http") {
      const e = mcpUrlError(s.url);
      if (e) ctx.addIssue({ code: "custom", path: ["url"], message: e });
    }
  });
export type McpServerInput = z.input<typeof McpServerInput>;

export const McpToolInfo = z.object({
  name: z.string(),
  exposed: z.string(), // 모델에 보이는 이름
  title: z.string(),
  description: z.string(),
  readOnly: z.boolean(), // 서버가 readOnlyHint 를 단 도구 (서버의 주장)
  enabled: z.boolean(),
  changed: z.boolean(), // 켠 뒤 정의가 바뀌어 꺼짐 — 다시 확인해야 함
  definition: z.unknown(), // 지금 서버가 알린 정의 (켜면 이것을 고정)
  pinned: z.unknown().nullable(), // 켤 때 고정한 정의
});
export type McpToolInfo = z.infer<typeof McpToolInfo>;

export const McpStatus = z.enum(["idle", "connecting", "connected", "error"]);
export const McpServerInfo = z.object({
  id: z.string(),
  name: z.string(),
  transport: McpTransport,
  command: z.string(),
  args: z.array(z.string()),
  url: z.string(),
  envKeys: z.array(z.string()), // 값은 돌려주지 않는다
  headerKeys: z.array(z.string()),
  trust: McpTrust,
  enabled: z.boolean(),
  protocolVersion: z.string(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).nullable(),
  status: McpStatus,
  error: z.string(),
  tools: z.array(McpToolInfo),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type McpServerInfo = z.infer<typeof McpServerInfo>;

export const McpToolToggle = z.object({ enabled: z.boolean() });

/**
 * Claude Desktop 의 claude_desktop_config.json (mcpServers) → 저장 요청 목록.
 * 키가 이름 규칙에 맞지 않으면 영문·숫자·-·_ 만 남겨 20자로 자른다
 */
export function parseClaudeDesktopConfig(text: string): { servers: McpServerInput[]; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { servers: [], errors: ["JSON 형식이 아닙니다"] };
  }
  const map = (raw as { mcpServers?: unknown })?.mcpServers ?? raw;
  if (!map || typeof map !== "object" || Array.isArray(map))
    return { servers: [], errors: ['{"mcpServers": {...}} 형식이 아닙니다'] };
  const servers: McpServerInput[] = [];
  const errors: string[] = [];
  for (const [key, v] of Object.entries(map as Record<string, unknown>)) {
    const s = (v ?? {}) as Record<string, unknown>;
    const name =
      key
        .replace(/[^A-Za-z0-9_-]/g, "")
        .replace(/^[^A-Za-z]+/, "")
        .slice(0, 20) || "server";
    const strRecord = (x: unknown) =>
      Object.fromEntries(Object.entries((x ?? {}) as Record<string, unknown>).map(([k, val]) => [k, String(val)]));
    const input: McpServerInput =
      typeof s.url === "string"
        ? { name, transport: "http", url: s.url, headers: strRecord(s.headers) }
        : {
            name,
            transport: "stdio",
            command: String(s.command ?? ""),
            args: Array.isArray(s.args) ? s.args.map(String) : [],
            env: strRecord(s.env),
          };
    const r = McpServerInput.safeParse(input);
    if (r.success) servers.push(input);
    else errors.push(`${key}: ${r.error.issues[0]?.message ?? "형식 오류"}`);
  }
  return { servers, errors };
}
