// 테스트용: ChatService 가 쓰는 도구·메모리 구성 (실제 app.ts 와 같은 연결)
import type { Database } from "bun:sqlite";
import type { ServerEvent } from "@proprix/shared";
import type { AgentStore } from "../agents/store";
import type { LlmBackend } from "../context/llm-backend";
import type { LlmGate } from "../llm/gate";
import type { McpManager } from "../mcp/manager";
import { DEFAULT_MEMORY_OPTIONS, type MemoryOptions, MemoryService } from "../memory/service";
import { MemoryStore } from "../memory/store";
import { ReminderStore } from "../proactive/reminders";
import type { SkillService } from "../skills/service";
import type { TaskStore } from "../tasks/store";
import { ApprovalBroker, ToolCallStore } from "../tools/calls";
import { FileChangeStore } from "../tools/files";
import { NoteStore } from "../tools/notes";
import { ToolRegistry } from "../tools/registry";
import type { ChatTools } from "./chat";

export function makeChatTools(
  db: Database,
  llm: LlmBackend,
  gate: LlmGate,
  agents: AgentStore,
  emit: (e: ServerEvent) => void,
  opt: {
    approvalTimeoutMs?: number;
    memory?: Partial<MemoryOptions>;
    model?: string;
    now?: () => number;
    snapshotsDir?: string; // 주면 작업 폴더 도구를 켠다
    skills?: SkillService; // 주면 skill 도구를 켠다
    mcp?: McpManager; // 주면 MCP 도구를 켠다
    tasks?: TaskStore; // 주면 task_* 도구를 켠다
  } = {},
): ChatTools & { notes: NoteStore; reminders: ReminderStore } {
  const notes = new NoteStore(db);
  const memory = new MemoryService(db, new MemoryStore(db), llm, gate, agents, () => opt.model ?? "m", emit, {
    ...DEFAULT_MEMORY_OPTIONS,
    idleMs: 60 * 60_000, // 테스트 중 자동 추출이 끼어들지 않게
    ...opt.memory,
  });
  const reminders = new ReminderStore(db);
  return {
    registry: new ToolRegistry(
      notes,
      memory,
      reminders,
      opt.now,
      opt.snapshotsDir ? new FileChangeStore(db, opt.snapshotsDir) : undefined,
      opt.skills,
      opt.mcp,
      opt.tasks,
    ),
    reminders,
    calls: new ToolCallStore(db),
    approvals: new ApprovalBroker(),
    memory,
    notes,
    approvalTimeoutMs: opt.approvalTimeoutMs,
  };
}
