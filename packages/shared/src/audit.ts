// 도구 실행 감사 로그 (P10b): 도구 묶음과 인자 요약 (daemon 작업 기록·web 감사 화면이 함께 쓴다)

export type ToolGroup = "file" | "note" | "reminder" | "mcp" | "command" | "other";
export const TOOL_GROUPS: readonly ToolGroup[] = ["file", "note", "reminder", "mcp", "command", "other"];
export const COMMAND_TOOLS: readonly string[] = ["shell_run", "skill_run_script"];

export function toolGroup(name: string): ToolGroup {
  if (name.startsWith("fs_")) return "file";
  if (name.startsWith("note_")) return "note";
  if (name.startsWith("reminder_")) return "reminder";
  if (name.startsWith("mcp__")) return "mcp";
  if (COMMAND_TOOLS.includes(name)) return "command";
  return "other";
}

const ARG_VALUE_MAX = 80;
const ARGS_MAX = 200;

export const cutLine = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

// 모델이 보낸 인자(JSON 문자열)를 한 줄로: 긴 값(파일 내용 등)은 길이만
export function summarizeArgs(args: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return cutLine(args, ARGS_MAX);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return cutLine(args, ARGS_MAX);
  const parts = Object.entries(parsed).map(([k, v]) => {
    const text = typeof v === "string" ? v : JSON.stringify(v);
    return text.length > ARG_VALUE_MAX ? `${k}=<${text.length} chars>` : `${k}=${JSON.stringify(v)}`;
  });
  return cutLine(parts.join(", "), ARGS_MAX);
}
