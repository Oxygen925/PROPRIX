// 인증된 /api/* 라우트. 일치하는 라우트가 없으면 null

import {
  AgentInput,
  API_PREFIX,
  BackupRestoreRequest,
  CHARACTER_LIMITS,
  CommandInput,
  CommandPreviewRequest,
  CreateRoomRequest,
  CreateSubchatRequest,
  describeSchedule,
  expandCommand,
  LoungeRunRequest,
  MCP_PREFIX,
  McpServerInput,
  McpToolToggle,
  MemoryBulkRequest,
  MemoryInput,
  MemoryMergeRequest,
  NoteInput,
  PersonaImportRequest,
  PersonaInput,
  PreviewRequest,
  ResearchAskRequest,
  ResearchInput,
  ResearchRunRequest,
  RestoreRequest,
  RevokeToolRequest,
  RewindRequest,
  SaveFileRequest,
  SendMessageRequest,
  SettingsPatch,
  SHARED_SCOPE,
  SignOutRequest,
  SkillImportRequest,
  StartDebateRequest,
  scheduleError,
  TaskInput,
  TaskPreviewRequest,
  TeamInput,
  THEME_LIMITS,
  TOOL_GROUPS,
  type ToolCall,
  ToolCallStatus,
  ToolDecisionRequest,
  type ToolGroup,
  UpdateRoomRequest,
  upcoming,
  VisualFrameRequest,
} from "@proprix/shared";
import { CharacterError, type CharacterStore } from "../agents/character";
import { contentDisposition, exportJson, exportMarkdown, importJson, importMarkdown } from "../agents/persona-file";
import { runPreview } from "../agents/preview";
import type { AgentStore, DeleteError } from "../agents/store";
import type { SiwcAccount } from "../auth/account";
import type { ChatService } from "../chat/chat";
import type { LoungeScheduler } from "../chat/lounge";
import type { CommandStore } from "../commands/store";
import type { SummaryService } from "../context/summary";
import type { LlmGate } from "../llm/gate";
import type { McpManager } from "../mcp/manager";
import type { MemoryService } from "../memory/service";
import type { VectorIndex } from "../memory/vectors";
import type { ReminderStore } from "../proactive/reminders";
import type { SiteAccountStore } from "../research/accounts";
import type { PageReader } from "../research/browser";
import { researchMarkdown } from "../research/export";
import type { BrowserInstaller } from "../research/install";
import type { ConverseError, ResearchRunner, StartError } from "../research/runner";
import type { ResearchStore } from "../research/store";
import { SkillError } from "../skills/package";
import type { SkillService } from "../skills/service";
import type { BackupService } from "../storage/backup";
import { MB, type PackError } from "../storage/pack";
import { cancelRestore, clearRestoreResult, requestRestore, restoreState } from "../storage/restore";
import type { SettingsStore } from "../storage/settings";
import type { TaskScheduler } from "../tasks/scheduler";
import type { TaskStore } from "../tasks/store";
import type { TeamStore } from "../teams/store";
import { ThemeError, type ThemeStore } from "../themes/store";
import { AUDIT_PAGE_MAX, type AuditService } from "../tools/audit";
import type { FileChangeStore } from "../tools/files";
import type { NoteStore } from "../tools/notes";
import type { ToolRegistry } from "../tools/registry";
import { validateWorkspaceRoot, WorkspaceError } from "../tools/workspace";
import type { UpdateChecker } from "../update/check";
import { apiError, type EventHub, readJson } from "./http";
import type { VisualFrames } from "./visual-frames";

export interface ApiDeps {
  dataDir: string;
  characters: CharacterStore;
  themes: ThemeStore;
  research: {
    installer: BrowserInstaller;
    reader: PageReader;
    store: ResearchStore;
    runner: ResearchRunner;
    accounts: SiteAccountStore;
  };
  teams: TeamStore;
  audit: AuditService;
  changes: FileChangeStore;
  backup: BackupService;
  visualFrames: VisualFrames;
  updates: UpdateChecker;
  account: SiwcAccount;
  gate: LlmGate;
  chat: ChatService;
  agents: AgentStore;
  summaries: SummaryService;
  settings: SettingsStore;
  notes: NoteStore;
  commands: CommandStore;
  skills: SkillService;
  mcp: McpManager;
  tasks: TaskStore;
  taskScheduler: TaskScheduler;
  memory: MemoryService;
  tools: ToolRegistry;
  hub: EventHub;
  lounge: LoungeScheduler;
  vectors: VectorIndex;
  reminders: ReminderStore;
}

export type ApiRoutes = (req: Request, path: string) => Promise<Response | null>;

const ID = "([0-9a-f-]{36})";
const PERSONA_PATH = new RegExp(`^/personas/${ID}$`);
const PERSONA_EXPORT_PATH = new RegExp(`^/personas/${ID}/export$`);
const THEME_PATH = /^\/themes\/([a-z0-9][a-z0-9-]{0,39})$/;
const PERSONA_CHARACTER_PATH = new RegExp(`^/personas/${ID}/character(/export)?$`);
const AGENT_PATH = new RegExp(`^/agents/${ID}$`);
const AGENT_REVOKE_PATH = new RegExp(`^/agents/${ID}/revoke-tool$`);
const ROOM_PATH = new RegExp(
  `^/rooms/${ID}(?:/(messages|cancel|summary|tool-calls|extract-memories|debates|export|file-changes|files|subchat|reference))?$`,
);
const FILE_CHANGE_RESTORE_PATH = new RegExp(`^/file-changes/${ID}/restore$`);
const ATTACHMENT_PATH = new RegExp(`^/attachments/${ID}$`);
const REWIND_PATH = new RegExp(`^/rooms/${ID}/messages/${ID}/rewind$`);
const MEMORY_PATH = new RegExp(`^/memories/${ID}$`);
const MEMORY_USES_PATH = new RegExp(`^/memories/${ID}/uses$`);
const TOOL_DECISION_PATH = new RegExp(`^/tool-calls/${ID}/decision$`);
const TOOL_UNDO_PATH = new RegExp(`^/tool-calls/${ID}/undo$`);
const NOTE_PATH = new RegExp(`^/notes/${ID}$`);
const COMMAND_PATH = new RegExp(`^/commands/${ID}$`);
const TEAM_PATH = new RegExp(`^/teams/${ID}$`);
const RESEARCH_PATH = new RegExp(`^/research/${ID}(?:/(run|cancel|runs|ask|timeline|export))?$`);
const RESEARCH_RUN_PATH = new RegExp(`^/research/runs/${ID}$`);
const AGENT_ACCOUNTS_PATH = new RegExp(`^/agents/${ID}/site-accounts$`);
const SITE_ACCOUNT_PATH = new RegExp(`^/site-accounts/${ID}(/test)?$`);
const RESEARCH_START_ERROR: Record<StartError, [Parameters<typeof apiError>[0], string]> = {
  not_found: ["not_found", "없는 리서치입니다"],
  running: ["conflict", "이미 실행 중"],
  no_browser: ["conflict", "리서치 브라우저가 설치돼 있지 않습니다. 설정에서 설치하세요"],
  no_model: ["conflict", "쓸 모델이 정해지지 않습니다"],
  no_agent: ["bad_request", "글쓴이 에이전트가 없습니다"],
  budget: ["conflict", "오늘 리서치 예산이 모자랍니다"],
  paused: ["conflict", "사용량 한도로 멈춘 상태"],
};
const RESEARCH_ASK_ERROR: Record<ConverseError, [Parameters<typeof apiError>[0], string]> = {
  not_found: ["not_found", "없는 리서치입니다"],
  running: ["conflict", "실행하거나 답을 쓰는 중입니다"],
  no_model: ["conflict", "쓸 모델이 정해지지 않습니다"],
  no_agent: ["bad_request", "이 리서치의 에이전트가 아닙니다"],
  budget: ["conflict", "오늘 리서치 예산이 모자랍니다"],
  paused: ["conflict", "사용량 한도로 멈춘 상태"],
  no_result: ["conflict", "아직 결과 글이 없습니다. 먼저 조사를 실행하세요"],
};
const SKILL_STAGE_PATH = new RegExp(`^/skills/import/${ID}(/commit)?$`);
const SKILL_PATH = /^\/skills\/([^/]+)$/;
const TASK_PATH = new RegExp(`^/tasks/${ID}(?:/(run|runs))?$`);
const ROOM_TASK_MESSAGES = new RegExp(`^/rooms/${ID}/task-messages$`);
const RUN_NOW_ERROR: Record<string, string> = {
  running: "이미 실행 중입니다",
  busy: "그 채팅이 응답 중입니다. 잠시 뒤 다시 하세요",
  paused: "사용량 한도로 멈춰 있습니다",
  no_model: "모델이 정해지지 않았습니다",
};
const MCP_SERVER_PATH = new RegExp(`^/mcp/servers/${ID}(?:/(refresh|log))?$`);
const MCP_TOOL_PATH = new RegExp(`^/mcp/servers/${ID}/tools/([^/]+)$`);

// 가져오기 검증 오류는 사용자에게 그대로 (400), 그 밖은 서버 오류
const skillError = (e: unknown): Response => {
  if (e instanceof SkillError) return apiError("bad_request", e.message);
  console.error("[skills]", e);
  return apiError("internal", "Skill 처리 중 오류가 났습니다");
};

// 저장소가 돌려준 오류: invalid 400, taken 409, not_found 404
const storeError = (e: { error: "invalid" | "taken" | "not_found"; message: string }) =>
  apiError(e.error === "invalid" ? "bad_request" : e.error === "taken" ? "conflict" : "not_found", e.message);

// zip 올리기: 본문을 받기 전에 크기를 보고, 묶음 검증 오류는 사용자에게 그대로 (400)
async function zipUpload<T>(
  req: Request,
  limit: number,
  Err: PackError,
  save: (zip: Uint8Array) => T,
): Promise<T | Response> {
  const size = Number(req.headers.get("content-length") ?? 0);
  if (size > limit) return apiError("bad_request", `zip 은 ${MB(limit)} 까지입니다`);
  try {
    return save(new Uint8Array(await req.arrayBuffer()));
  } catch (e) {
    if (e instanceof Err) return apiError("bad_request", e.message);
    throw e;
  }
}

function deleteError(e: DeleteError, what: string): Response {
  if (e === "not_found") return apiError("not_found", `없는 ${what}입니다`);
  if (e === "builtin") return apiError("conflict", `기본 ${what}는 삭제할 수 없습니다`);
  return apiError("conflict", `사용 중인 ${what}라 삭제할 수 없습니다`);
}

export function createRoutes(d: ApiDeps): ApiRoutes {
  const emitAccount = () => d.hub.emit({ type: "account", account: d.account.info() });

  return async (req, fullPath) => {
    const path = fullPath.slice(API_PREFIX.length);
    const m = req.method;

    // ---- 계정 ----
    if (path === "/account" && m === "GET") return Response.json(d.account.info());

    if (path === "/account/signin" && m === "POST") {
      const attempt = await d.account.beginSignIn();
      if ("ok" in attempt) return apiError("conflict", `로그인을 시작할 수 없습니다: ${attempt.code}`);
      void attempt.result.then((signIn) => d.hub.emit({ type: "account", account: d.account.info(), signIn }));
      return Response.json({ authorizeUrl: attempt.authorizeUrl });
    }
    if (path === "/account/signin/cancel" && m === "POST") {
      d.account.cancelSignIn();
      return Response.json({ ok: true });
    }
    if (path === "/account/signout" && m === "POST") {
      const body = await readJson(req, SignOutRequest);
      if (body instanceof Response) return body;
      // 문서: 진행 중인 요청을 먼저 멈춘 뒤 revoke
      await d.chat.cancelAll();
      await d.research.runner.cancelAll();
      const r = await d.account.signOut(body.forceLocal); // 기억 추출·요약처럼 남은 요청은 여기서 끊는다
      emitAccount();
      return Response.json(r);
    }
    if (path === "/account/welcome-shown" && m === "POST") {
      d.account.markWelcomeShown();
      emitAccount();
      return Response.json({ ok: true });
    }

    if (path === "/models" && m === "GET") {
      const { result, models } = await d.account.listModels();
      if (!result.ok) {
        if (result.recovery === "re_sign_in") emitAccount();
        return apiError("upstream", "모델 목록을 받지 못했습니다", { code: result.code, recovery: result.recovery });
      }
      return Response.json(models);
    }

    // ---- LLM 게이트 ----
    if (path === "/llm" && m === "GET") return Response.json(d.gate.status());
    if (path === "/llm/resume" && m === "POST") {
      d.gate.resume();
      return Response.json(d.gate.status());
    }

    // ---- 설정 ----
    if (path === "/settings" && m === "GET") return Response.json(d.settings.all());
    if (path === "/settings" && m === "PATCH") {
      const body = await readJson(req, SettingsPatch);
      if (body instanceof Response) return body;
      const r = d.settings.patch(body);
      if (typeof r === "string") return apiError("bad_request", r);
      if (body.memory) void d.vectors.configure(r.memory.embedding);
      if (body.memory?.autoExtract) d.memory.resumePending();
      return Response.json(r);
    }
    if (path === "/update" && m === "GET") {
      const latest = d.settings.all().updateCheck ? await d.updates.latest() : null;
      return Response.json({ latest });
    }
    if (path === "/usage" && m === "GET") return Response.json(d.gate.usageToday());
    if (path === "/usage/history" && m === "GET") {
      const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get("days")) || 365, 1), 400);
      return Response.json(d.gate.history(days));
    }

    // ---- 리마인더 ----
    if (path === "/reminders" && m === "GET") return Response.json(d.reminders.scheduled());
    const reminderMatch = new RegExp(`^/reminders/${ID}$`).exec(path);
    if (reminderMatch && m === "DELETE")
      return d.reminders.cancel(reminderMatch[1] ?? "")
        ? Response.json({ cancelled: true })
        : apiError("not_found", "예약 중인 리마인더가 아닙니다");

    // ---- 자율 대화 (라운지) ----
    if (path === "/lounge" && m === "GET") return Response.json(d.lounge.status());
    if (path === "/lounge/run" && m === "POST") {
      const body = await readJson(req, LoungeRunRequest);
      if (body instanceof Response) return body;
      const r = d.lounge.runNow(body.model);
      if (typeof r !== "string") return Response.json(r);
      const why: Record<string, string> = {
        busy: "다른 응답이 진행 중입니다",
        no_agents: "라운지에 참여할 에이전트가 2명 이상이어야 합니다",
        budget: "오늘 남은 라운지 예산이 세션 하나(발언 수)에 모자랍니다",
        paused: "사용량 한도로 일시정지 중입니다",
      };
      return apiError(r === "busy" ? "conflict" : "bad_request", why[r] ?? r);
    }

    // ---- 페르소나 ----
    if (path === "/personas" && m === "GET") return Response.json(d.agents.personas());
    if (path === "/personas" && m === "POST") {
      const body = await readJson(req, PersonaInput);
      if (body instanceof Response) return body;
      return Response.json(d.agents.createPersona(body));
    }
    if (path === "/personas/import" && m === "POST") {
      const body = await readJson(req, PersonaImportRequest);
      if (body instanceof Response) return body;
      const input = body.format === "json" ? importJson(body.data) : importMarkdown(body.text, body.name);
      if (typeof input === "string") return apiError("bad_request", input);
      return Response.json(d.agents.createPersona(input));
    }
    const personaMatch = PERSONA_PATH.exec(path);
    if (personaMatch) {
      const id = personaMatch[1] ?? "";
      if (m === "GET") {
        const p = d.agents.persona(id);
        return p ? Response.json(p) : apiError("not_found", "없는 페르소나입니다");
      }
      if (m === "PUT") {
        const body = await readJson(req, PersonaInput);
        if (body instanceof Response) return body;
        const p = d.agents.updatePersona(id, body);
        return p ? Response.json(p) : apiError("not_found", "없는 페르소나입니다");
      }
      if (m === "DELETE") {
        const e = d.agents.deletePersona(id);
        if (e) return deleteError(e, "페르소나");
        d.characters.remove(id);
        return Response.json({ ok: true });
      }
    }
    if (path === "/themes" && m === "GET") return Response.json(d.themes.list());
    if (path === "/themes" && m === "POST") {
      const saved = await zipUpload(req, THEME_LIMITS.zipBytes, ThemeError, (zip) => d.themes.save(zip));
      return saved instanceof Response ? saved : Response.json(saved);
    }
    const themeMatch = THEME_PATH.exec(path);
    if (themeMatch) {
      const id = themeMatch[1] ?? "";
      if (m === "GET") {
        const b = d.themes.bundle(id);
        return b ? Response.json(b) : apiError("not_found", "없는 테마입니다");
      }
      if (m === "DELETE")
        return d.themes.remove(id) ? Response.json({ ok: true }) : apiError("not_found", "없는 테마입니다");
    }
    const characterMatch = PERSONA_CHARACTER_PATH.exec(path);
    if (characterMatch) {
      const id = characterMatch[1] ?? "";
      const persona = d.agents.persona(id);
      if (!persona) return apiError("not_found", "없는 페르소나입니다");
      if (characterMatch[2]) {
        if (m !== "GET") return apiError("not_found", "없는 API 입니다");
        const zip = d.characters.source(id);
        if (!zip) return apiError("not_found", "표정 묶음이 없습니다");
        return new Response(zip, {
          headers: {
            "content-type": "application/zip",
            "content-disposition": contentDisposition(persona.name, "zip"),
          },
        });
      }
      if (m === "GET") {
        const pack = d.characters.pack(id);
        return pack ? Response.json(pack) : apiError("not_found", "표정 묶음이 없습니다");
      }
      if (m === "POST") {
        const saved = await zipUpload(req, CHARACTER_LIMITS.zipBytes, CharacterError, (zip) =>
          d.characters.save(id, zip),
        );
        if (saved instanceof Response) return saved;
        d.hub.emit({ type: "agents" });
        return Response.json(d.agents.persona(id));
      }
      if (m === "DELETE") {
        d.characters.remove(id);
        d.hub.emit({ type: "agents" });
        return Response.json(d.agents.persona(id));
      }
    }
    const exportMatch = PERSONA_EXPORT_PATH.exec(path);
    if (exportMatch && m === "GET") {
      const p = d.agents.persona(exportMatch[1] ?? "");
      if (!p) return apiError("not_found", "없는 페르소나입니다");
      if (new URL(req.url).searchParams.get("format") === "markdown")
        return new Response(exportMarkdown(p), {
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": contentDisposition(p.name, "md"),
          },
        });
      return new Response(JSON.stringify(exportJson(p), null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": contentDisposition(p.name, "json"),
        },
      });
    }

    // ---- 에이전트 ----
    if (path === "/agents/status" && m === "GET") return Response.json(d.chat.agentStatuses());
    const revokeMatch = AGENT_REVOKE_PATH.exec(path);
    if (revokeMatch && m === "POST") {
      const body = await readJson(req, RevokeToolRequest);
      if (body instanceof Response) return body;
      const a = d.chat.revokeTool(revokeMatch[1] ?? "", body.tool);
      return a ? Response.json(a) : apiError("not_found", "없는 에이전트입니다");
    }
    if (path === "/agents" && m === "GET") return Response.json(d.agents.agents());
    if (path === "/agents" && m === "POST") {
      const body = await readJson(req, AgentInput);
      if (body instanceof Response) return body;
      const a = d.agents.createAgent(body);
      return a ? Response.json(a) : apiError("bad_request", "없는 페르소나입니다");
    }
    if (path === "/agents/preview" && m === "POST") {
      const body = await readJson(req, PreviewRequest);
      if (body instanceof Response) return body;
      return Response.json(await runPreview(d.account, d.gate, body));
    }
    const agentMatch = AGENT_PATH.exec(path);
    if (agentMatch) {
      const id = agentMatch[1] ?? "";
      if (m === "PUT") {
        const body = await readJson(req, AgentInput);
        if (body instanceof Response) return body;
        const r = d.agents.updateAgent(id, body);
        if (r === "not_found") return apiError("not_found", "없는 에이전트입니다");
        if (r === "no_persona") return apiError("bad_request", "없는 페르소나입니다");
        return Response.json(r);
      }
      if (m === "DELETE") {
        const e = d.agents.deleteAgent(id);
        if (e) return deleteError(e, "에이전트");
        d.teams.removeAgent(id);
        d.research.accounts.prune(); // 그 에이전트의 사이트 계정 비밀 파일
        await d.research.reader.forgetAgent(id);
        return Response.json({ ok: true });
      }
    }

    // ---- 도구 ----
    if (path === "/tools" && m === "GET") return Response.json(d.tools.list());
    if (path === "/tool-calls/pending" && m === "GET") return Response.json(d.chat.pendingCalls());
    const decisionMatch = TOOL_DECISION_PATH.exec(path);
    if (decisionMatch && m === "POST") {
      const body = await readJson(req, ToolDecisionRequest);
      if (body instanceof Response) return body;
      if (!d.chat.decide(decisionMatch[1] ?? "", body.approve, body.always))
        return apiError("conflict", "확인 대기 중인 도구 호출이 아닙니다 (이미 결정됨·시간 초과·중지)");
      return Response.json({ ok: true });
    }

    // ---- 검색·첨부·백업 ----
    if (path === "/search" && m === "GET") {
      const p = new URL(req.url).searchParams;
      const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined);
      return Response.json(
        d.chat.search({
          q: p.get("q") ?? "",
          roomId: p.get("room") || undefined,
          agentId: p.get("agent") || undefined,
          from: num("from"),
          to: num("to"),
          limit: num("limit"),
        }),
      );
    }
    const attachmentMatch = ATTACHMENT_PATH.exec(path);
    if (attachmentMatch && m === "GET") {
      const a = d.chat.attachments.content(attachmentMatch[1] ?? "");
      return a ? Response.json(a) : apiError("not_found", "없는 첨부입니다");
    }
    // 감사 로그: 모든 방의 쓰기 도구 호출 (최신순, next 로 이어 받기)
    if (path === "/tool-calls" && m === "GET") {
      const q = new URL(req.url).searchParams;
      const group = q.get("group") ?? "";
      const status = q.get("status") ?? "";
      return Response.json(
        d.audit.list({
          roomId: q.get("room") ?? "",
          group: (TOOL_GROUPS as readonly string[]).includes(group) ? (group as ToolGroup) : undefined,
          status: (ToolCallStatus.options as readonly string[]).includes(status)
            ? (status as ToolCall["status"])
            : undefined,
          before: q.get("before") ?? "",
          limit: Math.min(Math.max(Number(q.get("limit")) || 50, 1), AUDIT_PAGE_MAX),
        }),
      );
    }
    const undoMatch = TOOL_UNDO_PATH.exec(path);
    if (undoMatch && m === "POST") {
      const r = d.audit.undo(undoMatch[1] ?? "");
      if (r === "ok") return Response.json({ ok: true });
      if (r === "not_found") return apiError("not_found", "없는 도구 호출입니다");
      if (r === "already") return apiError("conflict", "이미 되돌렸거나 남아 있지 않습니다");
      return apiError("bad_request", "되돌릴 수 없는 호출입니다");
    }
    const restoreMatch = FILE_CHANGE_RESTORE_PATH.exec(path);
    if (restoreMatch && m === "POST") {
      const body = await readJson(req, RestoreRequest);
      if (body instanceof Response) return body;
      const r = d.changes.restore(restoreMatch[1] ?? "", body.force);
      if (r === "ok") return Response.json({ ok: true });
      if (r === "not_found") return apiError("not_found", "없는 변경 기록입니다");
      if (r === "already") return apiError("conflict", "이미 되돌렸습니다");
      if (r === "missing_snapshot") return apiError("conflict", "보관 기간이 지나 원본이 없습니다");
      return apiError("conflict", "그 뒤 파일이 또 바뀌었습니다. 덮어쓰려면 다시 확인하세요");
    }
    if (path === "/snapshots" && m === "GET") return Response.json(d.changes.usage());
    if (path === "/snapshots" && m === "DELETE") {
      d.changes.clear();
      return Response.json(d.changes.usage());
    }
    if (path === "/visual-frames" && m === "POST") {
      const body = await readJson(req, VisualFrameRequest);
      if (body instanceof Response) return body;
      return Response.json({ id: d.visualFrames.put(body.doc) });
    }
    const backupInfo = () =>
      Response.json({ dir: d.backup.dir, items: d.backup.list(), restore: restoreState(d.dataDir) });
    if (path === "/backup" && m === "GET") return backupInfo();
    if (path === "/backup" && m === "POST") {
      try {
        d.backup.runNow();
      } catch (err) {
        return apiError("internal", `백업하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
      }
      return backupInfo();
    }
    // 복구는 표시만 하고, 다음 시작 때 DB 를 열기 전에 적용한다
    if (path === "/backup/restore" && m === "POST") {
      const body = await readJson(req, BackupRestoreRequest);
      if (body instanceof Response) return body;
      const problem = requestRestore(d.dataDir, body.name);
      return problem ? apiError("bad_request", problem) : backupInfo();
    }
    if (path === "/backup/restore" && m === "DELETE") {
      cancelRestore(d.dataDir);
      return backupInfo();
    }
    if (path === "/backup/restore-result" && m === "DELETE") {
      clearRestoreResult(d.dataDir);
      return backupInfo();
    }

    // ---- 메모 ----
    if (path === "/notes" && m === "GET")
      return Response.json(d.notes.list(new URL(req.url).searchParams.get("q") ?? "", 500));
    if (path === "/notes" && m === "POST") {
      const body = await readJson(req, NoteInput);
      if (body instanceof Response) return body;
      return Response.json(d.notes.create(body));
    }
    const noteMatch = NOTE_PATH.exec(path);
    if (noteMatch) {
      const id = noteMatch[1] ?? "";
      if (m === "PUT") {
        const body = await readJson(req, NoteInput);
        if (body instanceof Response) return body;
        const n = d.notes.update(id, body);
        return n ? Response.json(n) : apiError("not_found", "없는 메모입니다");
      }
      if (m === "DELETE")
        return d.notes.delete(id) ? Response.json({ ok: true }) : apiError("not_found", "없는 메모입니다");
    }

    // ---- / 명령 (사용자 정의) ----
    if (path === "/commands" && m === "GET") return Response.json(d.commands.list());
    if (path === "/commands" && m === "POST") {
      const body = await readJson(req, CommandInput);
      if (body instanceof Response) return body;
      const r = d.commands.create(body);
      return "error" in r ? storeError(r) : Response.json(r);
    }
    if (path === "/commands/preview" && m === "POST") {
      const body = await readJson(req, CommandPreviewRequest);
      if (body instanceof Response) return body;
      return Response.json(expandCommand(body.template, body.args));
    }
    const commandMatch = COMMAND_PATH.exec(path);
    if (commandMatch) {
      const id = commandMatch[1] ?? "";
      if (m === "PUT") {
        const body = await readJson(req, CommandInput);
        if (body instanceof Response) return body;
        const r = d.commands.update(id, body);
        return "error" in r ? storeError(r) : Response.json(r);
      }
      if (m === "DELETE")
        return d.commands.delete(id) ? Response.json({ ok: true }) : apiError("not_found", "없는 명령어입니다");
    }

    // ---- 팀 프리셋 ----
    if (path === "/teams" && m === "GET") return Response.json(d.teams.list());
    if (path === "/teams" && m === "POST") {
      const body = await readJson(req, TeamInput);
      if (body instanceof Response) return body;
      const r = d.teams.create(body);
      return "error" in r ? storeError(r) : Response.json(r);
    }
    const teamMatch = TEAM_PATH.exec(path);
    if (teamMatch) {
      const id = teamMatch[1] ?? "";
      if (m === "PUT") {
        const body = await readJson(req, TeamInput);
        if (body instanceof Response) return body;
        const r = d.teams.update(id, body);
        return "error" in r ? storeError(r) : Response.json(r);
      }
      if (m === "DELETE")
        return d.teams.delete(id) ? Response.json({ ok: true }) : apiError("not_found", "없는 팀입니다");
    }

    // ---- Skill ----
    if (path === "/skills" && m === "GET") {
      await d.skills.runners.check();
      return Response.json(d.skills.list());
    }
    if (path === "/skills/runners" && m === "GET")
      return Response.json(await d.skills.runners.check(new URL(req.url).searchParams.get("refresh") === "1"));
    if (path === "/skills/import" && m === "POST") {
      const body = await readJson(req, SkillImportRequest);
      if (body instanceof Response) return body;
      try {
        await d.skills.runners.check();
        return Response.json(d.skills.stage(body));
      } catch (e) {
        return skillError(e);
      }
    }
    const stageMatch = SKILL_STAGE_PATH.exec(path);
    if (stageMatch) {
      const id = stageMatch[1] ?? "";
      if (m === "POST" && stageMatch[2])
        try {
          return Response.json(d.skills.commit(id));
        } catch (e) {
          return skillError(e);
        }
      if (m === "DELETE" && !stageMatch[2]) {
        d.skills.discard(id);
        return Response.json({ ok: true });
      }
    }
    const skillMatch = SKILL_PATH.exec(path);
    if (skillMatch) {
      const name = decodeURIComponent(skillMatch[1] ?? "");
      if (m === "GET") {
        await d.skills.runners.check();
        const s = d.skills.detail(name);
        return s ? Response.json(s) : apiError("not_found", "없는 Skill입니다");
      }
      if (m === "DELETE")
        return d.skills.remove(name) ? Response.json({ ok: true }) : apiError("not_found", "없는 Skill입니다");
    }

    // ---- 반복 예약 작업 ----
    if (path === "/tasks" && m === "GET") return Response.json(d.tasks.list());
    if (path === "/tasks" && m === "POST") {
      const body = await readJson(req, TaskInput);
      if (body instanceof Response) return body;
      const t = d.tasks.create(body);
      return "error" in t ? storeError(t) : Response.json(t);
    }
    if (path === "/tasks/preview" && m === "POST") {
      const body = await readJson(req, TaskPreviewRequest);
      if (body instanceof Response) return body;
      const now = Date.now();
      const schedule =
        body.schedule.kind === "interval" && body.schedule.anchor === undefined
          ? { ...body.schedule, anchor: now }
          : body.schedule;
      const error = scheduleError(schedule, now);
      return Response.json({
        text: describeSchedule(schedule),
        next: error ? [] : upcoming(schedule, now, body.count),
        error,
      });
    }
    const roomTasks = ROOM_TASK_MESSAGES.exec(path);
    if (roomTasks && m === "GET") return Response.json(d.tasks.messages(roomTasks[1] ?? ""));
    const taskMatch = TASK_PATH.exec(path);
    if (taskMatch) {
      const id = taskMatch[1] ?? "";
      const sub = taskMatch[2];
      if (sub === "runs" && m === "GET") return Response.json(d.tasks.runs(id));
      if (sub === "run" && m === "POST") {
        const r = d.taskScheduler.runNow(id);
        if (r === "not_found") return apiError("not_found", "없는 작업입니다");
        if (typeof r === "string") return apiError("conflict", RUN_NOW_ERROR[r] ?? r);
        return Response.json({ ok: true });
      }
      if (!sub && m === "PUT") {
        const body = await readJson(req, TaskInput);
        if (body instanceof Response) return body;
        const t = d.tasks.update(id, body);
        return "error" in t ? storeError(t) : Response.json(t);
      }
      if (!sub && m === "DELETE")
        return d.tasks.delete(id) ? Response.json({ ok: true }) : apiError("not_found", "없는 작업입니다");
    }

    // ---- MCP ----
    if (path === "/mcp/servers" && m === "GET") return Response.json(d.mcp.list());
    if (path === "/mcp/servers" && m === "POST") {
      const body = await readJson(req, McpServerInput);
      if (body instanceof Response) return body;
      const row = d.mcp.store.create(body);
      if ("error" in row) return storeError(row);
      if (row.enabled) void d.mcp.refresh(row.id).catch(() => {}); // 도구 목록을 받아 둔다 (상태는 이벤트로)
      return Response.json(d.mcp.info(row));
    }
    const mcpTool = MCP_TOOL_PATH.exec(path);
    if (mcpTool && m === "PUT") {
      const body = await readJson(req, McpToolToggle);
      if (body instanceof Response) return body;
      const id = mcpTool[1] ?? "";
      const t = d.mcp.store.setToolEnabled(id, decodeURIComponent(mcpTool[2] ?? ""), body.enabled);
      const row = d.mcp.store.get(id);
      return t && row ? Response.json(d.mcp.info(row)) : apiError("not_found", "없는 도구입니다");
    }
    const mcpServer = MCP_SERVER_PATH.exec(path);
    if (mcpServer) {
      const id = mcpServer[1] ?? "";
      const sub = mcpServer[2];
      if (sub === "log" && m === "GET") return Response.json(d.mcp.logTail(id));
      if (sub === "refresh" && m === "POST") {
        const row = d.mcp.store.get(id);
        if (!row) return apiError("not_found", "없는 서버입니다");
        try {
          await d.mcp.refresh(id);
        } catch (e) {
          return apiError("upstream", `연결하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
        }
        return Response.json(d.mcp.info(d.mcp.store.get(id) ?? row));
      }
      if (!sub && m === "PUT") {
        const body = await readJson(req, McpServerInput);
        if (body instanceof Response) return body;
        const row = d.mcp.store.update(id, body);
        if ("error" in row) return storeError(row);
        await d.mcp.disconnect(id); // 바뀐 설정으로 다시 연결하게
        if (row.enabled) void d.mcp.refresh(id).catch(() => {});
        return Response.json(d.mcp.info(row));
      }
      if (!sub && m === "DELETE") {
        const row = d.mcp.store.get(id);
        if (!row) return apiError("not_found", "없는 서버입니다");
        await d.mcp.disconnect(id);
        d.mcp.store.remove(id);
        d.agents.removeMcpServer(id);
        d.agents.revokeToolPrefix(`${MCP_PREFIX}${row.name}__`);
        d.tasks.revokeToolPrefix(`${MCP_PREFIX}${row.name}__`); // 예약 작업의 미리 허용 도구도
        d.hub.emit({ type: "agents" });
        return Response.json({ ok: true });
      }
    }

    // ---- 장기 메모리 ----
    const scopeExists = (scope: string) => scope === SHARED_SCOPE || d.agents.agent(scope) !== null;
    if (path === "/memory/embedding" && m === "GET") return Response.json(d.vectors.status());

    // ---- 리서치 (P11b) ----
    const agentAccounts = AGENT_ACCOUNTS_PATH.exec(path);
    if (agentAccounts) {
      const agentId = agentAccounts[1] ?? "";
      if (!d.agents.agent(agentId)) return apiError("not_found", "없는 에이전트입니다");
      if (m === "GET") return Response.json(d.research.accounts.list(agentId));
      if (m === "POST") {
        const r = d.research.accounts.create(agentId, await req.json().catch(() => null));
        return "error" in r ? storeError(r) : Response.json(r);
      }
    }
    const siteAccount = SITE_ACCOUNT_PATH.exec(path);
    if (siteAccount) {
      const id = siteAccount[1] ?? "";
      if (siteAccount[2] && m === "POST") {
        const a = d.research.accounts.get(id);
        if (!a) return apiError("not_found", "없는 계정입니다");
        if (!d.research.reader.available)
          return apiError("conflict", "리서치 브라우저가 설치돼 있지 않습니다. 설정에서 설치하세요");
        const outcome = await d.research.reader.testLogin(a);
        return Response.json({ outcome, account: d.research.accounts.get(id) });
      }
      const owner = d.research.accounts.get(id)?.agentId;
      if (m === "PUT") {
        const r = d.research.accounts.update(id, await req.json().catch(() => null));
        if (owner) await d.research.reader.forgetAgent(owner);
        return "error" in r ? storeError(r) : Response.json(r);
      }
      if (m === "DELETE") {
        if (!d.research.accounts.delete(id)) return apiError("not_found", "없는 계정입니다");
        if (owner) await d.research.reader.forgetAgent(owner);
        return Response.json({ ok: true });
      }
    }
    if (path === "/research" && m === "GET") return Response.json(d.research.store.list());
    if (path === "/research" && m === "POST") {
      const body = await readJson(req, ResearchInput);
      if (body instanceof Response) return body;
      const r = d.research.store.create(body);
      return "error" in r ? storeError(r) : Response.json(r);
    }
    const runMatch = RESEARCH_RUN_PATH.exec(path);
    if (runMatch && m === "GET") {
      const run = d.research.store.detail(runMatch[1] ?? "");
      return run ? Response.json(run) : apiError("not_found", "없는 실행입니다");
    }
    const researchMatch = RESEARCH_PATH.exec(path);
    if (researchMatch) {
      const id = researchMatch[1] ?? "";
      const sub = researchMatch[2];
      if (sub === "run" && m === "POST") {
        const body = await readJson(req, ResearchRunRequest);
        if (body instanceof Response) return body;
        const at = Date.now();
        const r = d.research.runner.start(id, { extra: body.extra, continue: body.continue });
        if (typeof r === "string") {
          const [code, msg] = RESEARCH_START_ERROR[r];
          return apiError(code, msg);
        }
        // 추가 지시는 실행 앞에 말풍선으로 남긴다
        if (body.extra)
          d.hub.emit({
            type: "research_message",
            message: d.research.store.addMessage({
              researchId: id,
              role: "user",
              kind: "instruction",
              agentId: "",
              text: body.extra,
              status: "done",
              at,
            }),
          });
        return Response.json(r.run);
      }
      if (sub === "ask" && m === "POST") {
        const body = await readJson(req, ResearchAskRequest);
        if (body instanceof Response) return body;
        const r = d.research.runner.converse(id, body.text, body.agentId);
        if (typeof r === "string") {
          const [code, msg] = RESEARCH_ASK_ERROR[r];
          return apiError(code, msg);
        }
        return Response.json(r.answer);
      }
      if (sub === "export" && m === "GET") {
        const r = d.research.store.get(id);
        if (!r) return apiError("not_found", "없는 리서치입니다");
        const md = researchMarkdown(r, d.research.store.timeline(id), (a) => d.agents.agent(a)?.name);
        return new Response(md, {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }
      if (sub === "timeline" && m === "GET") {
        if (!d.research.store.get(id)) return apiError("not_found", "없는 리서치입니다");
        return Response.json(d.research.store.timeline(id));
      }
      if (sub === "cancel" && m === "POST") return Response.json({ cancelled: d.research.runner.cancel(id) });
      if (sub === "runs" && m === "GET") return Response.json(d.research.store.runs(id));
      if (!sub && m === "PUT") {
        if (d.research.runner.isRunning(id)) return apiError("conflict", "실행 중에는 편집할 수 없습니다");
        const body = await readJson(req, ResearchInput);
        if (body instanceof Response) return body;
        const r = d.research.store.update(id, body);
        return "error" in r ? storeError(r) : Response.json(r);
      }
      if (!sub && m === "DELETE") {
        d.research.runner.cancel(id);
        return d.research.store.delete(id) ? Response.json({ ok: true }) : apiError("not_found", "없는 리서치입니다");
      }
    }

    // ---- 리서치 브라우저 (P11a) ----
    if (path === "/research/browser" && m === "GET") return Response.json(d.research.installer.status());
    if (path === "/research/browser/install" && m === "POST") {
      void d.research.installer.install();
      return Response.json(d.research.installer.status());
    }
    if (path === "/research/browser/cancel" && m === "POST") {
      d.research.installer.cancel();
      return Response.json(d.research.installer.status());
    }
    if (path === "/research/browser" && m === "DELETE") {
      await d.research.reader.close();
      d.research.installer.remove();
      return Response.json(d.research.installer.status());
    }
    if (path === "/memories" && m === "GET") {
      const q = new URL(req.url).searchParams;
      return Response.json(
        d.memory.store.list({ scope: q.get("scope") || undefined, history: q.get("history") === "1" }),
      );
    }
    // ---- 기억 관리 (P10e) ----
    if (path === "/memories/use-counts" && m === "GET") return Response.json(d.memory.useCounts());
    if (path === "/memories/graph" && m === "GET") return Response.json(d.memory.graph());
    if (path === "/memories/bulk" && m === "POST") {
      const body = await readJson(req, MemoryBulkRequest);
      if (body instanceof Response) return body;
      if (body.set?.scope && !scopeExists(body.set.scope))
        return apiError("bad_request", "없는 범위입니다 (shared 또는 에이전트 id)");
      return Response.json({ count: d.memory.store.bulk(body) });
    }
    if (path === "/memories/merge" && m === "POST") {
      const body = await readJson(req, MemoryMergeRequest);
      if (body instanceof Response) return body;
      if (!scopeExists(body.memory.scope)) return apiError("bad_request", "없는 범위입니다 (shared 또는 에이전트 id)");
      const merged = d.memory.store.merge(body.ids, body.memory);
      if (!merged) return apiError("not_found", "없는 기억이 들어 있습니다");
      if (!merged.contentEn) d.memory.scheduleNormalize();
      return Response.json(merged);
    }
    const usesMatch = MEMORY_USES_PATH.exec(path);
    if (usesMatch && m === "GET") return Response.json(d.memory.store.uses(usesMatch[1] ?? "", 50));
    if (path === "/memories" && m === "POST") {
      const body = await readJson(req, MemoryInput);
      if (body instanceof Response) return body;
      if (!scopeExists(body.scope)) return apiError("bad_request", "없는 범위입니다 (shared 또는 에이전트 id)");
      const created = d.memory.store.create(body);
      if (!created.contentEn) d.memory.scheduleNormalize();
      return Response.json(created);
    }
    const memoryMatch = MEMORY_PATH.exec(path);
    if (memoryMatch) {
      const id = memoryMatch[1] ?? "";
      if (m === "PUT") {
        const body = await readJson(req, MemoryInput);
        if (body instanceof Response) return body;
        if (!scopeExists(body.scope)) return apiError("bad_request", "없는 범위입니다 (shared 또는 에이전트 id)");
        const updated = d.memory.store.update(id, body);
        if (!updated) return apiError("not_found", "없는 기억입니다");
        if (!updated.contentEn) d.memory.scheduleNormalize();
        return Response.json(updated);
      }
      if (m === "DELETE")
        return d.memory.store.delete(id) ? Response.json({ ok: true }) : apiError("not_found", "없는 기억입니다");
    }

    // ---- 방·대화 ----
    if (path === "/rooms" && m === "GET") {
      d.chat.ensureDefaultRoom();
      return Response.json(d.chat.listRooms());
    }
    if (path === "/rooms" && m === "POST") {
      const body = await readJson(req, CreateRoomRequest);
      if (body instanceof Response) return body;
      const r = d.chat.createRoom(body.title, body.agentIds, body.chainLimit);
      return r === "no_agent" ? apiError("bad_request", "없는 에이전트입니다") : Response.json(r);
    }
    const rewindMatch = REWIND_PATH.exec(path);
    if (rewindMatch && m === "POST") {
      const [, roomId = "", messageId = ""] = rewindMatch;
      const body = await readJson(req, RewindRequest);
      if (body instanceof Response) return body;
      const r = d.chat.rewind(roomId, messageId, body.text, body.model);
      if (r === "not_found") return apiError("not_found", "없는 채팅입니다");
      if (r === "not_message") return apiError("not_found", "없는 메시지입니다");
      if (r === "busy") return apiError("conflict", "이 채팅에서 응답을 받는 중입니다");
      if (r === "no_agent") return apiError("conflict", "이 채팅에 에이전트가 없습니다");
      if (r === "lounge") return apiError("bad_request", "라운지 채팅은 다시 받을 수 없습니다");
      if (r === "not_user") return apiError("bad_request", "다시 보낼 사용자 메시지가 없습니다");
      if (r === "summarized") return apiError("conflict", "이미 요약에 들어간 오래된 메시지는 편집할 수 없습니다");
      return Response.json(r);
    }
    const roomMatch = ROOM_PATH.exec(path);
    if (roomMatch) {
      const [, roomId = "", action] = roomMatch;
      // 서브 채팅 (P9b)
      if (action === "subchat" && m === "POST") {
        const body = await readJson(req, CreateSubchatRequest);
        if (body instanceof Response) return body;
        const r = d.chat.createSubchat(roomId, body);
        if (r === "not_found") return apiError("not_found", "없는 채팅입니다");
        if (r === "not_message") return apiError("not_found", "없는 메시지입니다");
        if (r === "lounge") return apiError("bad_request", "라운지에서는 서브 채팅을 만들 수 없습니다");
        if (r === "nested") return apiError("bad_request", "서브 채팅에서는 다시 서브 채팅을 만들 수 없습니다");
        if (r === "no_agent") return apiError("bad_request", "없는 에이전트입니다");
        return Response.json(r);
      }
      if (action === "reference" && m === "GET") {
        if (!d.chat.room(roomId)) return apiError("not_found", "없는 채팅입니다");
        return Response.json({ reference: d.chat.reference(roomId) });
      }
      if (!action && m === "DELETE") {
        const res = d.chat.deleteRoom(roomId);
        if (res === "not_found") return apiError("not_found", "없는 채팅입니다");
        if (res === "busy") return apiError("conflict", "응답을 받는 중에는 채팅을 삭제할 수 없습니다");
        return Response.json({ deleted: true });
      }
      if (!action && m === "PATCH") {
        const body = await readJson(req, UpdateRoomRequest);
        if (body instanceof Response) return body;
        // 작업 폴더는 daemon 이 검증한 실제 경로로만 저장한다 ("" = 해제)
        let workspace = body.workspace;
        if (workspace) {
          try {
            workspace = validateWorkspaceRoot(workspace, d.dataDir);
          } catch (err) {
            return apiError("bad_request", err instanceof WorkspaceError ? err.message : "폴더를 확인하지 못했습니다");
          }
        }
        const r = d.chat.updateRoom(roomId, { ...body, workspace });
        if (r === "not_found") return apiError("not_found", "없는 채팅입니다");
        if (r === "no_agent") return apiError("bad_request", "없는 에이전트입니다");
        if (r === "busy") return apiError("conflict", "응답을 받는 중에는 참여자를 바꿀 수 없습니다");
        return Response.json(r);
      }
      if (!d.chat.room(roomId)) return apiError("not_found", "없는 채팅입니다");
      if (action === "messages" && m === "GET") return Response.json(d.chat.messages(roomId));
      if (action === "file-changes" && m === "GET") return Response.json(d.changes.forRoom(roomId));
      if (action === "files" && m === "POST") {
        const body = await readJson(req, SaveFileRequest);
        if (body instanceof Response) return body;
        const ws = d.chat.workspaceOf(roomId);
        if (!ws) return apiError("bad_request", "이 채팅에 작업 폴더가 없습니다");
        try {
          const r = d.changes.save(ws, body.path, body.content, `artifact:${body.messageId}`, roomId, body.overwrite);
          if (r === "exists") return apiError("conflict", "같은 이름의 파일이 있습니다");
          return Response.json(r);
        } catch (err) {
          if (err instanceof WorkspaceError) return apiError("bad_request", err.message);
          throw err;
        }
      }
      if (action === "export" && m === "GET") {
        const room = d.chat.room(roomId);
        return new Response(d.chat.exportMarkdown(roomId), {
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": contentDisposition(room?.title ?? "채팅", "md"),
          },
        });
      }
      if (action === "summary" && m === "GET") return Response.json(d.summaries.get(roomId));
      if (action === "tool-calls" && m === "GET") return Response.json(d.chat.toolCalls(roomId));
      if (action === "extract-memories" && m === "POST") return Response.json(await d.memory.extractNow(roomId));
      if (action === "messages" && m === "POST") {
        const body = await readJson(req, SendMessageRequest);
        if (body instanceof Response) return body;
        const r = d.chat.send(roomId, body.text, body.model, body.attachments);
        if (r === "not_found") return apiError("not_found", "없는 채팅입니다");
        if (r === "busy") return apiError("conflict", "이 채팅에서 응답을 받는 중입니다");
        if (r === "no_agent") return apiError("conflict", "이 채팅에 에이전트가 없습니다");
        return Response.json(r);
      }
      if (action === "cancel" && m === "POST") return Response.json({ cancelled: d.chat.cancel(roomId) });
      if (action === "debates" && m === "GET") return Response.json(d.chat.debatesOf(roomId));
      if (action === "debates" && m === "POST") {
        const body = await readJson(req, StartDebateRequest);
        if (body instanceof Response) return body;
        const { model, ...input } = body;
        const r = d.chat.startDebate(roomId, input, model);
        if (r === "not_found") return apiError("not_found", "없는 채팅입니다");
        if (r === "busy") return apiError("conflict", "이 채팅에서 응답을 받는 중입니다");
        if (r === "not_member") return apiError("bad_request", "토론 참여자는 이 채팅의 참여자여야 합니다");
        if (r === "no_agent") return apiError("bad_request", "없는 에이전트입니다");
        if (r === "budget") return apiError("bad_request", "오늘 토론 예산이 이 토론을 끝내기에 모자랍니다");
        return Response.json(r);
      }
    }
    return null;
  };
}
