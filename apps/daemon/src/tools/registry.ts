// 로컬 도구 목록과 실행. 인자는 모델이 만든 JSON 이라 스키마로 다시 검증하고, 결과는 JSON 문자열(잘라냄)로 돌려준다.
// 결과는 모델에 '데이터'로 들어간다 — instructions 에서 지시로 따르지 말라고 못박는다.
// 도구 정의는 defs/* 에 있다. 등록 순서가 곧 화면·모델에 나가는 순서다.

import { type Agent, DELEGATE_TOOL, MAX_WORKERS, type ToolInfo, WORKERS_TOOL } from "@proprix/shared";
import type { FunctionTool, ToolSpec } from "@proprix/siwc";
import type { McpManager } from "../mcp/manager";
import type { MemoryService } from "../memory/service";
import type { ReminderStore } from "../proactive/reminders";
import type { SkillService } from "../skills/service";
import type { TaskStore } from "../tasks/store";
import { type LocalTool, obj, type ToolContext, ToolInputError } from "./defs/define";
import { memoryTools } from "./defs/memory";
import { noteTools } from "./defs/notes";
import { reminderTools } from "./defs/reminders";
import { skillTools } from "./defs/skills";
import { taskTools } from "./defs/tasks";
import { workspaceTools } from "./defs/workspace";
import type { FileChangeStore, Workspace } from "./files";
import type { NoteStore } from "./notes";
import { WorkspaceError } from "./workspace";

export type { ToolContext } from "./defs/define";
export { ToolInputError } from "./defs/define";
export { externalUrl } from "./defs/notes";

export const MAX_TOOL_OUTPUT = 8000;

// 도구 목록을 고르는 데 쓰는 방 문맥
export interface ToolScope {
  workspace?: Workspace;
  skills?: string[];
  mcp?: string[]; // 이 실행에서 쓸 수 있는 MCP 서버 id
  unattended?: boolean; // 예약 작업 실행 중 (task_* 도구를 숨긴다 — 예약 작업이 예약 작업을 만들지 않게)
  memoryReadonly?: boolean; // 서브 채팅·/debate·/collab 토론: 장기 기억을 읽기만 (memory_save·memory_forget 숨김)
}

const MEMORY_WRITES = new Set(["memory_save", "memory_forget"]);

const isTaskTool = (name: string) => name.startsWith("task_");

// skill 이 있으면 에이전트 도구 목록과 관계없이 붙는다 (편집기의 'Skill' 에서 켠 것으로 충분)
export const SKILL_TOOLS = ["skill_load", "skill_read_file", "skill_run_script"];

// 위임: 실행은 비동기 LLM 루프라 ChatService 가 맡고, 여기서는 목록·스펙만 둔다. 쿼터만 쓰고 바깥에 남는 변화는 없어 read
const DELEGATE_INFO: ToolInfo = {
  name: DELEGATE_TOOL,
  title: "에이전트 위임",
  description:
    "Hand a self-contained task to another agent and get its answer back. It runs once with its own role and tools but without this conversation.",
  kind: "read",
};

const WORKERS_INFO: ToolInfo = {
  name: WORKERS_TOOL,
  title: "작업자 실행",
  description: `Start up to ${MAX_WORKERS} temporary workers at once, each doing one self-contained task with a subset of your tools, and get all their results back. Workers cannot see this conversation or ask questions.`,
  kind: "read",
};
// 작업자에게 줄 수 없는 도구 (작업자가 다시 작업자·위임·예약 작업을 만들지 않게)
export const WORKER_FORBIDDEN = (name: string) =>
  name === WORKERS_TOOL || name === DELEGATE_TOOL || name.startsWith("task_");

const errorText = (err: unknown) => (err instanceof WorkspaceError ? err.message : "tool failed");

export function truncate(s: string, max = MAX_TOOL_OUTPUT): string {
  return s.length <= max ? s : `${s.slice(0, max)}…(truncated ${s.length - max} chars)`;
}

export class ToolRegistry {
  private readonly tools = new Map<string, LocalTool>();
  private readonly mcp?: McpManager;

  constructor(
    notes: NoteStore,
    memory: MemoryService,
    reminders: ReminderStore,
    now: () => number = Date.now,
    changes?: FileChangeStore,
    skills?: SkillService,
    mcp?: McpManager,
    tasks?: TaskStore,
  ) {
    this.mcp = mcp;
    for (const t of [
      ...noteTools(notes),
      ...memoryTools(memory),
      ...reminderTools(reminders, now),
      ...(changes ? workspaceTools(changes) : []),
      ...(skills ? skillTools(skills) : []),
      ...(tasks ? taskTools(tasks) : []),
    ])
      this.tools.set(t.info.name, t);
  }

  // 위임 받은 실행에서 숨기는 도구
  topLevelOnly(name: string): boolean {
    return this.tools.get(name)?.topLevelOnly === true;
  }

  list(): ToolInfo[] {
    return [...[...this.tools.values()].map((t) => t.info), DELEGATE_INFO, WORKERS_INFO];
  }

  get(name: string): ToolInfo | undefined {
    if (name === DELEGATE_TOOL) return DELEGATE_INFO;
    if (name === WORKERS_TOOL) return WORKERS_INFO;
    return this.tools.get(name)?.info ?? (this.isMcpTool(name) ? this.mcp?.toolInfo(name) : undefined);
  }

  // MCP 도구 (mcp__서버__도구). 결과는 늘 턴을 오염시키고, 에이전트의 '모든 쓰기 확인 없이'는 적용하지 않는다
  isMcpTool(name: string): boolean {
    return !this.tools.has(name) && (this.mcp?.isMcp(name) ?? false);
  }

  // 쓰기 도구지만 오염되지 않은 턴에서는 확인 없이 실행
  trusted(name: string): boolean {
    return this.tools.get(name)?.trusted === true;
  }

  // 항상 허용·trusted 와 관계없이 늘 확인 (shell_run, skill_run_script, task_create)
  alwaysConfirm(name: string): boolean {
    return this.tools.get(name)?.info.alwaysConfirm === true;
  }

  taints(name: string): "external" | "workspace" | null {
    if (this.isMcpTool(name)) return "external";
    return this.tools.get(name)?.taints ?? null;
  }

  // 작업 폴더 안 파일만 바꾸는 도구 (되돌릴 수 있음)
  inWorkspace(name: string): boolean {
    return this.tools.get(name)?.info.requires === "workspace";
  }

  // 방 문맥에서 쓸 수 있는 도구인가 (작업 폴더·명령 실행·skill)
  private available(t: LocalTool, scope: ToolScope): boolean {
    if (scope.unattended && isTaskTool(t.info.name)) return false;
    if (scope.memoryReadonly && MEMORY_WRITES.has(t.info.name)) return false;
    const need = t.info.requires ?? "";
    if (need === "skill") return !!scope.skills?.length && (!t.needsShell || !!scope.workspace?.shell);
    return need === "" || (need === "workspace" ? !!scope.workspace : !!scope.workspace?.shell);
  }

  isSkillTool(name: string): boolean {
    return SKILL_TOOLS.includes(name) && this.tools.has(name);
  }

  usable(name: string, scope: ToolScope): boolean {
    if (this.isMcpTool(name)) {
      const server = this.mcp?.serverOf(name);
      return !!server && (scope.mcp ?? []).includes(server);
    }
    const t = this.tools.get(name);
    return t === undefined || this.available(t, scope); // 위임 등 목록 밖 도구는 따로 검사
  }

  /** 승인 전 준비 (prepare 가 있는 도구만). 실패하면 모델에 돌려줄 오류 */
  prepare(
    name: string,
    rawArgs: string,
    ctx: ToolContext,
  ): { ok: true; preview: string; state: unknown } | { ok: false; output: string } | null {
    const tool = this.tools.get(name);
    if (!tool?.prepare) return null;
    const args = this.parse(tool, rawArgs);
    if (!args.ok) return args;
    try {
      return { ok: true, ...tool.prepare(args.data as never, ctx) };
    } catch (err) {
      return { ok: false, output: JSON.stringify({ error: errorText(err) }) };
    }
  }

  private parse(tool: LocalTool, rawArgs: string): { ok: true; data: unknown } | { ok: false; output: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs || "{}");
    } catch {
      return { ok: false, output: JSON.stringify({ error: "arguments are not valid JSON" }) };
    }
    const args = tool.args.safeParse(parsed);
    return args.success
      ? { ok: true, data: args.data }
      : { ok: false, output: JSON.stringify({ error: `invalid arguments: ${args.error.issues[0]?.message ?? ""}` }) };
  }

  // 에이전트에 허용된 도구 → Responses tools. delegates: 지금 위임할 수 있는 에이전트 (이름표·사용자가 쓴 역할).
  // 없으면 위임 도구를 숨긴다
  specsFor(
    agent: Agent,
    delegates: readonly { label: string; role: string }[] = [],
    delegated = false,
    scope: ToolScope = {},
  ): ToolSpec[] {
    const names = scope.skills?.length ? [...new Set([...agent.tools, ...SKILL_TOOLS])] : agent.tools;
    const specs: ToolSpec[] = names
      .map((name) => this.tools.get(name))
      .filter((t): t is LocalTool => t !== undefined && !(delegated && t.topLevelOnly) && this.available(t, scope))
      .map(
        (t): FunctionTool => ({
          type: "function",
          name: t.info.name,
          description: t.describe?.() ?? t.info.description,
          parameters: t.parameters,
          strict: true,
        }),
      );
    if (agent.tools.includes(DELEGATE_TOOL) && delegates.length > 0)
      specs.push({
        type: "function",
        name: DELEGATE_TOOL,
        description: DELEGATE_INFO.description,
        strict: true,
        parameters: obj({
          agent: {
            type: "string",
            enum: delegates.map((d) => d.label),
            description: `The agent to hand the task to. Available agents:\n${delegates
              .map((d) => {
                const role = d.role.trim().replace(/\s+/g, " ");
                return `- ${d.label}: ${role.length > 120 ? `${role.slice(0, 120)}…` : role || "(no role)"}`;
              })
              .join("\n")}`,
          },
          task: {
            type: "string",
            description:
              "A self-contained task. The agent cannot see this conversation, so include every detail it needs.",
          },
        }),
      });
    // 작업자 띄우기: 방에서 직접 말하는 실행만 (위임 받은 실행·작업자에서는 숨김)
    if (agent.tools.includes(WORKERS_TOOL) && !delegated)
      specs.push({
        type: "function",
        name: WORKERS_TOOL,
        description: WORKERS_INFO.description,
        strict: true,
        parameters: obj({
          workers: {
            type: "array",
            description: `1 to ${MAX_WORKERS} workers that run at the same time.`,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "task", "tools"],
              properties: {
                title: { type: "string", description: "Short label for this worker." },
                task: {
                  type: "string",
                  description:
                    "A self-contained task. The worker cannot see this conversation, so include every detail.",
                },
                tools: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    'Names of your tools this worker may use (may be empty). Use "web_search" to let it search the web if you can.',
                },
              },
            },
          },
        }),
      });
    if (this.mcp && scope.mcp?.length) specs.push(...this.mcp.specs(scope.mcp));
    if (agent.webSearch) specs.push({ type: "web_search" });
    return specs;
  }

  // 인자 검증 후 실행. 결과·오류 모두 모델에 돌려줄 JSON 문자열
  async run(
    name: string,
    rawArgs: string,
    ctx: ToolContext,
    prepared?: unknown,
  ): Promise<{ ok: boolean; output: string }> {
    if (this.mcp && this.isMcpTool(name)) return this.mcp.call(name, rawArgs, ctx.signal);
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, output: JSON.stringify({ error: `unknown tool: ${name}` }) };
    const args = this.parse(tool, rawArgs);
    if (!args.ok) return args;
    try {
      return {
        ok: true,
        output: truncate(JSON.stringify(await tool.run(args.data as never, ctx, prepared as never)), tool.maxOutput),
      };
    } catch (err) {
      if (err instanceof WorkspaceError || err instanceof ToolInputError)
        return { ok: false, output: JSON.stringify({ error: err.message }) };
      console.error(`[tool] ${name} 실행 오류`, err);
      return { ok: false, output: JSON.stringify({ error: "tool failed" }) };
    }
  }
}
