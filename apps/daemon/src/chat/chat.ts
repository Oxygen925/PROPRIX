// 채팅: 방·참여 에이전트·메시지 저장, 스트리밍, 중지, 도구 호출 루프, 그룹챗 연쇄, 에이전트 간 위임.
// 요청은 에이전트의 역할·페르소나와 롤링 요약으로 조립한다. 그룹챗(참여자 2명 이상)은 @멘션 → 라우터 → 라운드로빈으로
// 첫 화자를 고르고, 답에 다른 참여자 @멘션이 있으면 이어서 답하게 한다 (사용자 발화 1회당 방의 연쇄 상한까지).
// 이력에는 텍스트만 다시 보낸다 — 이전 턴의 도구 결과는 다음 턴에 들어가지 않는다 (P3a 기본값).
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
  type Agent,
  type AgentState,
  type AgentStatus,
  type AttachmentInput,
  commandKey,
  DELEGATE_TOOL,
  type Debate,
  type LoungeSession,
  MAX_DELEGATION_DEPTH,
  MAX_WORKERS,
  type Memory,
  type Message,
  type MessageStatus,
  parseSlash,
  type Recovery,
  type Room,
  type ServerEvent,
  type StartDebateRequest,
  SUBCHAT_REFERENCE_MAX,
  type ToolCall,
  WORKER_CALL,
  WORKERS_TOOL,
  type WorkspaceRules,
} from "@proprix/shared";
import { type ChatTurn, citationsOf, type Source, type ToolSpec } from "@proprix/siwc";
import { z } from "zod";
import { type AgentStore, DEFAULT_AGENT_ID } from "../agents/store";
import { failedResult, type StreamResult } from "../auth/account";
import {
  agentMessage,
  buildInstructions,
  type DebatePart,
  fence,
  type LoungePart,
  type ProactivePart,
} from "../context/instructions";
import type { LlmBackend } from "../context/llm-backend";
import type { HistoryTurn, SummaryService } from "../context/summary";
import type { LlmGate } from "../llm/gate";
import { lastUsedModel } from "../llm/model";
import type { MemoryService } from "../memory/service";
import { formatLocal } from "../proactive/time";
import type { SkillService } from "../skills/service";
import { parseIds } from "../storage/rows";
import type { ApprovalBroker, ToolCallStore } from "../tools/calls";
import type { Workspace } from "../tools/files";
import { type ToolRegistry, truncate, WORKER_FORBIDDEN } from "../tools/registry";
import { parseRules, protectedRules, WorkspacePolicy } from "../tools/workspace";
import { type AttachmentRow, AttachmentStore, attachToTurns } from "./attachments";
import { DebateStore } from "./debates";
import { roomMarkdown } from "./export";
import { LoungeStore } from "./lounge-store";
import { type SearchQuery, searchMessages } from "./search";
import { findMentions, labelAgents, nextInTurn, routeSpeakers } from "./speakers";
import { defaultSubTitle, isDefaultTitle, makeTitle } from "./title";
import { workLog } from "./worklog";

export const MAX_TOOL_STEPS = 6; // 한 턴의 LLM 요청 상한 (도구 결과마다 한 번씩 더 보낸다)
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const ROUTER_CONTEXT = 6; // 라우터에 보여 주는 최근 메시지 수
const PROACTIVE_KICKOFF = "(The user has not written anything new. Write your message to them now.)";
const TASK_KICKOFF = "(Scheduled task run. The user is away. Do the task now and write your report.)";
const TASK_TIMEOUT_MS = 10 * 60_000; // 예약 작업 한 번의 제한 시간
const UNATTENDED_DENIED =
  "Not allowed in this scheduled task: the user is away and did not pre-approve this action (or this turn read " +
  "untrusted outside data). Do not retry it; mention in your report that it was not done.";
const LOUNGE_KICKOFF = "(A new lounge session is starting now. No user is present. Open the conversation.)";

export interface ChatTools {
  registry: ToolRegistry;
  calls: ToolCallStore;
  approvals: ApprovalBroker;
  memory: MemoryService;
  approvalTimeoutMs?: number;
}

interface MessageRow {
  id: string;
  room_id: string;
  role: "user" | "assistant";
  agent_id: string;
  content: string;
  status: MessageStatus;
  model: string;
  error_code: string;
  recovery: Recovery;
  sources: string;
  memory_ids: string;
  debate_id: string;
  debate_round: number;
  proactive: Message["proactive"];
  created_at: number;
}

function parseSources(raw: string): Source[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as Source[]) : [];
  } catch {
    return [];
  }
}

// 라우터·기억 검색에는 글만 (첨부만 보냈으면 첨부 이름)
const chainQuery = (text: string, attachments: readonly { name: string }[]) =>
  text || attachments.map((a) => a.name).join(", ");

const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  roomId: r.room_id,
  role: r.role,
  agentId: r.agent_id,
  content: r.content,
  status: r.status,
  model: r.model,
  errorCode: r.error_code,
  recovery: r.recovery,
  sources: parseSources(r.sources),
  memoryIds: parseIds(r.memory_ids),
  debateId: r.debate_id,
  debateRound: r.debate_round,
  proactive: r.proactive,
  attachments: [],
  createdAt: r.created_at,
});

interface RoomRow {
  id: string;
  title: string;
  chain_limit: number;
  kind: "chat" | "lounge";
  pinned: number;
  archived: number;
  workspace: string;
  workspace_rules: string;
  shell_enabled: number;
  parent_room_id: string;
  parent_message_id: string;
  parent_title: string;
  created_at: number;
  updated_at: number;
}

export type SendError = "not_found" | "busy" | "no_agent";
// not_message 없는 메시지 / not_user 다시 보낼 사용자 메시지가 없음(토론·선제 메시지) / summarized 이미 요약에 들어감
export type RewindError = SendError | "lounge" | "not_message" | "not_user" | "summarized";

// 웹 검색 결과가 들어감 → 이후 쓰기 도구는 '항상 허용'이어도 확인. 사용자 발화 1회의 처리 전체(연쇄의 다음 화자,
// 위임 하위·상위)에서 공유한다 — 검색한 에이전트의 답이 다음 화자에게 그대로 들어가므로
interface Taint {
  searched: boolean;
  external?: boolean; // 명령 출력·MCP 결과처럼 밖에서 온 데이터가 들어감
  // 작업 폴더 파일 내용이 들어감 → 폴더 밖으로 이어지는 쓰기(기억·리마인더 등)만 확인.
  // 폴더 안 파일 쓰기는 되돌릴 수 있으므로 '항상 허용'을 지킨다 (사용자 결정 2026-10-29)
  workspace?: boolean;
  // 직전 턴의 오염: 그 턴의 답이 기록으로 다시 들어가므로 다음 한 턴은 같은 기준으로 확인한다 (사용자 결정 2026-11-01)
  carried?: "outside" | "workspace";
  debate: boolean; // 토론·협업 중: 에이전트끼리 주고받은 말이 계속 쌓이므로 쓰기는 항상 확인 (사용자 결정 2026-10-28)
  unattended?: Unattended; // 예약 작업: 사용자가 없다 (위임 하위 실행에도 이어진다)
}

// 예약 작업 한 번의 결과 (실행 기록에 남긴다)
export interface TaskOutcome {
  status: "done" | "failed" | "cancelled";
  reason: string;
  messageId: string;
  requests: number;
  rejected: number;
}

// 예약 작업의 무인 승인: 승인 대기를 만들지 않는다. 미리 허용한 쓰기 도구만, 늘 확인 도구·오염된 턴은 거절
// (사용자 결정 2026-10-29). requests·rejected 는 실행 기록용
interface Unattended {
  allowed: string[];
  requests: number;
  rejected: number;
}

// 응답 메시지 하나의 실행 상태 (출처는 메시지마다, 오염 표시는 발화 전체에서 공유)
interface TurnState {
  taint: Taint;
  sources: Source[];
  // 이번 답에서 사용자가 부모(방의 화자)에게 '한 번 허용'한 도구 — 작업자는 이 도구를 확인 없이 쓴다 (사용자 결정 2026-10-29)
  approved: Set<string>;
}

// 에이전트 한 번 실행 (방의 응답 또는 위임 받은 일)
interface AgentRun {
  agent: Agent;
  model: string;
  instructions: string;
  turns: ChatTurn[];
  roomId: string;
  messageId: string; // 도구 호출이 붙는 assistant 메시지 (위임 하위도 상위 메시지에 붙는다)
  parentId: string; // 위임 하위면 그 위임 호출 id
  path: string[]; // 위임 경로 (자기 포함) — 경로에 있는 에이전트로는 다시 위임하지 않는다
  signal: AbortSignal;
  onDelta: (text: string) => void;
  state: TurnState;
  feature: "chat" | "delegate" | "debate" | "lounge" | "proactive" | "tasks";
  worker?: { tools: Set<string> }; // 임시 작업자: 이 도구만 쓴다
  skills: string[]; // 이 실행에서 쓸 수 있는 skill
  mcp: string[]; // 이 실행에서 쓸 수 있는 MCP 서버 id
  noTools?: boolean; // 자율 대화: 확인해 줄 사용자가 없으므로 도구 없이
}

interface ReplyInput {
  roomId: string;
  agent: Agent;
  members: Agent[]; // 함께 말하는 에이전트 (자기 포함). 2명 이상이면 그룹 규칙
  query: string; // 기억 검색어
  defaultModel: string;
  ctrl: AbortController;
  taint: Taint;
  debate?: { id: string; round: number; part: DebatePart };
  lounge?: LoungePart;
  proactive?: ProactivePart;
  noTools?: boolean;
  memories?: Memory[]; // 정해 둔 기억 (없으면 query 로 검색)
  skill?: InvokedSkill; // 사용자가 /이름 으로 부른 skill (이 발화의 모든 화자에게)
  task?: { title: string; prompt: string }; // 예약 작업 실행 (taint.unattended 와 함께)
  context?: DebateContext; // /debate·/collab: 호출한 대화의 기억·도구 작업
}

// /debate·/collab 을 연 대화의 맥락. 시작할 때 한 번 만들어 고정한다 (토론 중의 도구 호출은 이력으로 이미 보인다)
interface DebateContext {
  memories: Memory[];
  workLog: string;
}

interface InvokedSkill {
  name: string;
  args: string;
}

export type StartDebateInput = Omit<StartDebateRequest, "model">;

const DelegateArgs = z.object({ agent: z.string(), task: z.string().trim().min(1).max(8000) });
const WorkersArgs = z.object({
  workers: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(80),
        task: z.string().trim().min(1).max(8000),
        tools: z.array(z.string().max(64)).max(50),
      }),
    )
    .min(1)
    .max(MAX_WORKERS),
});
const WORKER_RESULT_MAX = 7000; // 작업자 하나의 결과 (전체는 WORKERS_OUTPUT_MAX)
const WORKERS_OUTPUT_MAX = 30_000;

export class ChatService {
  // roomId → 진행 중 응답 연쇄 (done: 결과 저장과 요약 판단까지 끝나면 resolve)
  private readonly running = new Map<string, { ctrl: AbortController; done: Promise<void> }>();
  private readonly titled = new Set<string>(); // 자동 제목을 시도한 방 (이번 실행)
  private readonly contextDebates = new Set<string>(); // /debate·/collab 토론이 진행 중인 방
  private seq = 0;
  private readonly debates: DebateStore;
  // 에이전트별 지금 상태 (메모리에만 — 재시작하면 모두 idle)
  private readonly statuses = new Map<string, AgentStatus>();
  private readonly debatingRooms = new Set<string>();
  readonly lounges: LoungeStore;

  readonly attachments: AttachmentStore;

  // 전역 지침 (설정). 라운지에는 넣지 않는다 (사용자 결정 2026-10-29)
  globalInstructions: () => string = () => "";

  constructor(
    private readonly db: Database,
    private readonly llm: LlmBackend,
    private readonly gate: LlmGate,
    private readonly agents: AgentStore,
    private readonly summaries: SummaryService,
    private readonly tools: ChatTools,
    private readonly emit: (ev: ServerEvent) => void,
  ) {
    this.debates = new DebateStore(db);
    this.attachments = new AttachmentStore(db);
    this.lounges = new LoungeStore(db);
    // 이전 실행에서 끝나지 못한 스트림 정리
    db.query(
      "UPDATE messages SET status = 'partial', error_code = 'daemon_restarted' WHERE status = 'streaming'",
    ).run();
  }

  // 같은 밀리초에 만든 메시지도 순서가 유지되게 단조 증가 시각을 쓴다
  private stamp(): number {
    const now = Date.now();
    this.seq = Math.max(this.seq + 1, now);
    return this.seq;
  }

  private agentName(id: string): string {
    return this.agents.agent(id)?.name ?? "agent";
  }

  // ---- 방 ----

  private members(roomId: string): string[] {
    return this.db
      .query<{ agent_id: string }, { room: string }>(
        "SELECT agent_id FROM room_members WHERE room_id = $room ORDER BY position",
      )
      .all({ room: roomId })
      .map((r) => r.agent_id);
  }

  private toRoom(r: RoomRow): Room {
    return {
      id: r.id,
      title: r.title,
      agentIds: this.members(r.id),
      chainLimit: r.chain_limit,
      kind: r.kind,
      running: this.running.has(r.id),
      pinned: r.pinned === 1,
      archived: r.archived === 1,
      workspace: r.workspace,
      workspaceRules: parseRules(r.workspace_rules),
      shellEnabled: r.shell_enabled === 1,
      parentRoomId: r.parent_room_id,
      parentMessageId: r.parent_message_id,
      parentTitle: r.parent_title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listRooms(): Room[] {
    return this.db
      .query<RoomRow, []>("SELECT * FROM rooms ORDER BY updated_at DESC")
      .all()
      .map((r) => this.toRoom(r));
  }

  room(id: string): Room | null {
    const r = this.db.query<RoomRow, { id: string }>("SELECT * FROM rooms WHERE id = $id").get({ id });
    return r ? this.toRoom(r) : null;
  }

  // 지금 있는 참여자 (지워진 에이전트는 뺀다)
  private memberAgents(room: Room): Agent[] {
    return room.agentIds.map((id) => this.agents.agent(id)).filter((a): a is Agent => a !== null);
  }

  // 방에서 마지막으로 말한 에이전트 ("" = 없음)
  private lastAssistant(roomId: string): string {
    return (
      this.db
        .query<{ agent_id: string }, { room: string }>(
          "SELECT agent_id FROM messages WHERE room_id = $room AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
        )
        .get({ room: roomId })?.agent_id ?? ""
    );
  }

  private setMembers(roomId: string, agentIds: string[]) {
    this.db.query("DELETE FROM room_members WHERE room_id = $room").run({ room: roomId });
    const insert = this.db.query("INSERT INTO room_members (room_id, agent_id, position) VALUES ($room, $agent, $pos)");
    for (const [pos, agent] of agentIds.entries()) insert.run({ room: roomId, agent, pos });
  }

  // ---- 서브 채팅 (P9b) ----

  // 서브 채팅·/debate·/collab 토론: 장기 기억은 읽기만 (넘겨받은 기억을 다른 범위로 옮겨 저장하지 못하게)
  private memoryReadonly(roomId: string): boolean {
    return this.contextDebates.has(roomId) || this.isSubchat(roomId);
  }

  isSubchat(roomId: string): boolean {
    return !!this.db
      .query<{ p: string }, { id: string }>("SELECT parent_room_id AS p FROM rooms WHERE id = $id")
      .get({ id: roomId })?.p;
  }

  /** 만들 때 복사해 둔 부모 대화 참조 ("" = 일반 방) */
  reference(roomId: string): string {
    return (
      this.db
        .query<{ r: string }, { id: string }>("SELECT reference AS r FROM rooms WHERE id = $id")
        .get({ id: roomId })?.r ?? ""
    );
  }

  /**
   * 기존 대화에서 서브 채팅을 만든다. 분기 메시지까지의 대화(요약 + 그 뒤 메시지)를 복사해 두고 참조만 한다.
   * 일반 채팅만 부모가 될 수 있다 (라운지·서브의 서브는 안 됨)
   */
  createSubchat(
    parentId: string,
    p: { messageId?: string; agentIds?: string[]; title?: string },
  ): Room | "not_found" | "lounge" | "nested" | "not_message" | "no_agent" {
    const parent = this.room(parentId);
    if (!parent) return "not_found";
    if (parent.kind === "lounge") return "lounge";
    if (parent.parentRoomId) return "nested";
    const agentIds = p.agentIds ?? parent.agentIds;
    if (agentIds.length === 0 || agentIds.some((id) => !this.agents.agent(id))) return "no_agent";
    const all = this.messages(parentId).filter((m) => !m.debateId && m.status !== "streaming" && m.content.trim());
    const fork = p.messageId ? all.find((m) => m.id === p.messageId) : all.at(-1);
    if (p.messageId && !fork) return "not_message";
    const upto = fork ? all.filter((m) => m.createdAt <= fork.createdAt) : [];

    // 요약이 분기 시점 뒤까지 덮고 있으면 (오래된 메시지에서 분기) 요약은 넣지 않는다 — 분기 뒤 내용이 새지 않게
    const sum = this.summaries.get(parentId);
    const useSummary = !!sum?.summary && !!fork && sum.coveredUntil <= fork.createdAt;
    const lines = upto
      .filter((m) => !useSummary || m.createdAt > (sum?.coveredUntil ?? 0))
      .map(
        (m) =>
          `[${formatLocal(m.createdAt)}] ${m.role === "user" ? "User" : this.agentName(m.agentId)}: ${m.content.trim()}`,
      );
    const head = useSummary ? `Summary of the earlier conversation:\n${sum?.summary.trim()}\n\n` : "";
    const kept: string[] = [];
    let size = head.length;
    for (const line of [...lines].reverse()) {
      if (size + line.length + 2 > SUBCHAT_REFERENCE_MAX) break;
      kept.unshift(line);
      size += line.length + 2;
    }
    const omitted = lines.length - kept.length;
    const reference = `${head}${omitted ? `(${omitted} older messages omitted)\n\n` : ""}${kept.join("\n\n")}`.trim();

    const now = Date.now();
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO rooms (id, title, chain_limit, parent_room_id, parent_message_id, parent_title, reference,
           created_at, updated_at)
           VALUES ($id, $title, $limit, $parent, $message, $parentTitle, $reference, $now, $now)`,
        )
        .run({
          id,
          title: p.title ?? defaultSubTitle(parent.title),
          limit: parent.chainLimit,
          parent: parentId,
          message: fork?.id ?? "",
          parentTitle: parent.title,
          reference,
          now,
        });
      this.setMembers(id, agentIds);
    })();
    this.emit({ type: "rooms" });
    return this.room(id) as Room;
  }

  // 없는 에이전트가 있으면 "no_agent"
  createRoom(title: string, agentIds: string[] = [DEFAULT_AGENT_ID], chainLimit = 3): Room | "no_agent" {
    if (agentIds.some((id) => !this.agents.agent(id))) return "no_agent";
    const now = Date.now();
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO rooms (id, title, chain_limit, created_at, updated_at) VALUES ($id, $title, $limit, $now, $now)",
        )
        .run({ id, title, limit: chainLimit, now });
      this.setMembers(id, agentIds);
    })();
    return this.room(id) as Room;
  }

  updateRoom(
    id: string,
    patch: {
      title?: string;
      agentIds?: string[];
      chainLimit?: number;
      pinned?: boolean;
      archived?: boolean;
      workspace?: string; // 이미 검증한 실제 경로 ("" = 해제)
      workspaceRules?: WorkspaceRules;
      shellEnabled?: boolean;
    },
  ): Room | "not_found" | "no_agent" | "busy" {
    if (!this.room(id)) return "not_found";
    if (patch.agentIds?.some((a) => !this.agents.agent(a))) return "no_agent";
    if (patch.agentIds && this.running.has(id)) return "busy";
    this.db.transaction(() => {
      if (patch.title) this.db.query("UPDATE rooms SET title = $title WHERE id = $id").run({ id, title: patch.title });
      if (patch.chainLimit)
        this.db.query("UPDATE rooms SET chain_limit = $limit WHERE id = $id").run({ id, limit: patch.chainLimit });
      if (patch.agentIds) this.setMembers(id, patch.agentIds);
      if (patch.pinned !== undefined)
        this.db.query("UPDATE rooms SET pinned = $v WHERE id = $id").run({ id, v: patch.pinned ? 1 : 0 });
      if (patch.archived !== undefined)
        this.db.query("UPDATE rooms SET archived = $v WHERE id = $id").run({ id, v: patch.archived ? 1 : 0 });
      if (patch.workspace !== undefined) {
        this.db.query("UPDATE rooms SET workspace = $v WHERE id = $id").run({ id, v: patch.workspace });
        // 폴더를 바꾸거나 해제하면 명령 실행은 다시 꺼진다 (새 폴더에서 다시 켜도록)
        this.db.query("UPDATE rooms SET shell_enabled = 0 WHERE id = $id").run({ id });
      }
      if (patch.workspaceRules)
        this.db
          .query("UPDATE rooms SET workspace_rules = $v WHERE id = $id")
          .run({ id, v: JSON.stringify(patch.workspaceRules) });
      if (patch.shellEnabled !== undefined)
        this.db.query("UPDATE rooms SET shell_enabled = $v WHERE id = $id").run({ id, v: patch.shellEnabled ? 1 : 0 });
    })();
    return this.room(id) as Room;
  }

  // 응답 중이면 "busy". 메시지·도구 호출·요약·토론·리마인더 등은 함께 지워지고 기억은 남는다
  deleteRoom(id: string): "not_found" | "busy" | null {
    if (!this.room(id)) return "not_found";
    if (this.running.has(id)) return "busy";
    this.db.query("DELETE FROM rooms WHERE id = $id").run({ id });
    for (const [agentId, st] of this.statuses) if (st.roomId === id) this.statuses.set(agentId, { ...st, roomId: "" });
    this.emit({ type: "rooms" });
    return null;
  }

  // ---- 작업 폴더 ----

  // 작업 폴더 안에 있어도 다루지 못하게 할 폴더 (PROPRIX 데이터 폴더)
  protectedDirs: () => string[] = () => [];
  skills: SkillService | null = null;

  workspaceOf(roomId: string): Workspace | undefined {
    const room = this.room(roomId);
    if (!room?.workspace || !existsSync(room.workspace)) return undefined;
    const guard = protectedRules(room.workspace, this.protectedDirs());
    return {
      root: room.workspace,
      policy: new WorkspacePolicy({ ...room.workspaceRules, deny: [...room.workspaceRules.deny, ...guard] }),
      shell: room.shellEnabled,
    };
  }

  // instructions 에 넣을 작업 폴더 안내 (이 에이전트가 파일 도구를 쓸 수 있을 때만)
  private workspaceHint(agent: Agent, roomId: string): { root: string; shell: boolean } | undefined {
    const w = this.workspaceOf(roomId);
    if (!w || !agent.tools.some((t) => t.startsWith("fs_"))) return undefined;
    return { root: basename(w.root), shell: w.shell && agent.tools.includes("shell_run") };
  }

  // ---- Skill ----

  // 이 실행에서 쓸 수 있는 skill: 에이전트가 켠 것 + 사용자가 부른 것 (켜지 않았어도 그 턴만 — 사용자 결정 2026-10-29)
  private skillsFor(agent: Agent, invoked?: string): string[] {
    const store = this.skills;
    if (!store) return [];
    const names = agent.skills.map((n) => store.canonical(n)).filter((n): n is string => n !== null);
    if (invoked && !names.some((n) => commandKey(n) === commandKey(invoked))) names.push(invoked);
    return names;
  }

  // 발화가 "/skill이름 인자" 로 시작하면 그 skill 을 부른다 (다시 받기·수정도 같은 글로 다시 판단)
  private invokedSkill(text: string): InvokedSkill | undefined {
    const slash = parseSlash(text.trim());
    const name = slash ? this.skills?.canonical(slash.name) : null;
    return slash && name ? { name, args: slash.rest } : undefined;
  }

  private skillHint(names: string[], invoked?: InvokedSkill) {
    const store = this.skills;
    if (!store || names.length === 0) return undefined;
    return {
      available: names
        .map((n) => store.describe(n))
        .filter((d): d is { name: string; description: string } => d !== null),
      invoked: invoked ? { name: invoked.name, body: store.body(invoked.name), args: invoked.args } : undefined,
    };
  }

  // 이 에이전트가 쓰는 MCP 서버 (켜 둔 것만)
  mcpServersOf: (agent: Agent) => string[] = () => [];

  // ---- 검색·내보내기 ----

  search(q: SearchQuery) {
    return searchMessages(this.db, q);
  }

  exportMarkdown(roomId: string): string | null {
    const room = this.room(roomId);
    return room ? roomMarkdown(room, this.messages(roomId), (id) => this.agentName(id)) : null;
  }

  // ---- 에이전트 상태 ----

  agentStatuses(): AgentStatus[] {
    return [...this.statuses.values()];
  }

  private setStatus(agentId: string, state: AgentState, text: string, roomId: string) {
    const prev = this.statuses.get(agentId);
    if (prev && prev.state === state && prev.text === text && prev.roomId === roomId) return;
    const status: AgentStatus = {
      agentId,
      state,
      text,
      roomId,
      debate: this.debatingRooms.has(roomId),
      at: Date.now(),
    };
    this.statuses.set(agentId, status);
    this.emit({ type: "agent_status", status });
  }

  // 한 번의 실행이 끝났을 때의 상태
  private finishStatus(agentId: string, roomId: string, result: StreamResult, doneText: string) {
    if (result.outcome === "completed") this.setStatus(agentId, "done", doneText, roomId);
    else if (result.outcome === "cancelled" || result.code === "cancelled")
      this.setStatus(agentId, "idle", "중지됨", roomId);
    else if (result.recovery === "usage_limit") this.setStatus(agentId, "blocked", "사용량 한도", roomId);
    else if (result.code === "daily_budget_exceeded") this.setStatus(agentId, "blocked", "오늘 예산을 다 씀", roomId);
    else this.setStatus(agentId, "blocked", `오류 · ${result.code || result.outcome}`, roomId);
  }

  ensureDefaultRoom(): void {
    if (!this.db.query("SELECT 1 FROM rooms LIMIT 1").get()) this.createRoom("새 채팅");
  }

  messages(roomId: string): Message[] {
    const files = this.attachments.infoByMessage(roomId);
    return this.db
      .query<MessageRow, { room: string }>("SELECT * FROM messages WHERE room_id = $room ORDER BY created_at")
      .all({ room: roomId })
      .map((r) => ({ ...toMessage(r), attachments: files.get(r.id) ?? [] }));
  }

  private insert(m: Message) {
    this.db
      .query(
        `INSERT INTO messages (id, room_id, role, agent_id, content, status, model, error_code, recovery, sources,
         memory_ids, debate_id, debate_round, proactive, created_at)
         VALUES ($id, $room_id, $role, $agent_id, $content, $status, $model, $error_code, $recovery, $sources, $memory_ids,
         $debate_id, $debate_round, $proactive, $created_at)`,
      )
      .run({
        id: m.id,
        room_id: m.roomId,
        role: m.role,
        agent_id: m.agentId,
        content: m.content,
        status: m.status,
        model: m.model,
        error_code: m.errorCode,
        recovery: m.recovery,
        sources: JSON.stringify(m.sources),
        memory_ids: JSON.stringify(m.memoryIds),
        debate_id: m.debateId,
        debate_round: m.debateRound,
        proactive: m.proactive,
        created_at: m.createdAt,
      });
    this.db.query("UPDATE rooms SET updated_at = $t WHERE id = $id").run({ t: m.createdAt, id: m.roomId });
    this.emit({ type: "message", message: m });
  }

  // ---- 대화 ----

  // defaultModel: 전역 기본 모델. 에이전트에 모델이 지정돼 있으면 그쪽이 우선.
  // 응답은 화자가 정해질 때마다 "message" 이벤트로 나간다 (연쇄 시작·끝은 "turn")
  send(
    roomId: string,
    text: string,
    defaultModel: string,
    attachments: AttachmentInput[] = [],
  ): { user: Message } | SendError {
    const room = this.room(roomId);
    if (!room) return "not_found";
    if (this.running.has(roomId)) return "busy";
    const members = this.memberAgents(room);
    if (members.length === 0 || members.some((a) => !this.agents.persona(a.personaId))) return "no_agent";

    let user = this.userMessage(roomId, text);
    this.insert(user);
    if (attachments.length) {
      user = { ...user, attachments: this.attachments.add(user.id, roomId, attachments, user.createdAt) };
      this.emit({ type: "message", message: user });
    }
    this.tools.memory.noteActivity(roomId);

    const query = chainQuery(text, attachments);
    this.begin(roomId, (ctrl) => this.chain(room, members, query, defaultModel, ctrl));
    return { user };
  }

  // 수정해서 다시 보내기(text 있음)·답 다시 받기(text 없음). 사용자 결정 2026-10-29: 이전 답은 교체, 요약 전의
  // 최근 메시지면 아무거나, 그룹방은 그 턴 전체를 다시. messageId 가 답이면 그 앞의 사용자 메시지부터 다시 하고,
  // 그 사용자 메시지 뒤의 대화(답·도구 호출·토론)는 지운다. 도구가 이미 한 일(메모·리마인더·기억)은 되돌리지 않는다
  rewind(
    roomId: string,
    messageId: string,
    text: string | undefined,
    defaultModel: string,
  ): { user: Message } | RewindError {
    const room = this.room(roomId);
    if (!room) return "not_found";
    if (room.kind === "lounge") return "lounge";
    if (this.running.has(roomId)) return "busy";
    const members = this.memberAgents(room);
    if (members.length === 0 || members.some((a) => !this.agents.persona(a.personaId))) return "no_agent";

    const all = this.messages(roomId);
    const at = all.findIndex((m) => m.id === messageId);
    if (at < 0) return "not_message";
    if (text !== undefined && all[at]?.role !== "user") return "not_user";
    let u = at;
    while (u >= 0 && all[u]?.role !== "user") u--;
    const target = all[u];
    if (!target || target.debateId) return "not_user";
    if (target.createdAt <= (this.summaries.get(roomId)?.coveredUntil ?? 0)) return "summarized";

    const removed = all.slice(u + 1).map((m) => m.id);
    const after = { room: roomId, t: target.createdAt };
    this.db.transaction(() => {
      this.db.query("DELETE FROM messages WHERE room_id = $room AND created_at > $t").run(after);
      this.db.query("DELETE FROM tool_calls WHERE room_id = $room AND created_at > $t").run(after);
      this.db.query("DELETE FROM debates WHERE room_id = $room AND created_at > $t").run(after);
      if (text !== undefined)
        this.db.query("UPDATE messages SET content = $text WHERE id = $id").run({ text, id: target.id });
    })();
    const user = text === undefined ? target : { ...target, content: text };
    if (removed.length > 0) this.emit({ type: "messages_removed", roomId, ids: removed });
    if (text !== undefined) this.emit({ type: "message", message: user });
    this.tools.memory.noteActivity(roomId);

    const query = chainQuery(user.content, user.attachments);
    this.begin(roomId, (ctrl) => this.chain(room, members, query, defaultModel, ctrl));
    return { user };
  }

  private userMessage(roomId: string, content: string, debateId = ""): Message {
    return {
      id: crypto.randomUUID(),
      roomId,
      role: "user",
      agentId: "",
      content,
      status: "complete",
      model: "",
      errorCode: "",
      recovery: "none",
      sources: [],
      memoryIds: [],
      debateId,
      debateRound: 0,
      proactive: "",
      attachments: [],
      createdAt: this.stamp(),
    };
  }

  // 응답 연쇄·토론을 등록하고 시작한다 (정리는 run 의 finally 에서 end)
  private begin(roomId: string, run: (ctrl: AbortController) => Promise<void>) {
    const entry = { ctrl: new AbortController(), done: Promise.resolve() };
    this.running.set(roomId, entry);
    this.emit({ type: "turn", roomId, running: true });
    entry.done = run(entry.ctrl);
  }

  private end(roomId: string) {
    this.running.delete(roomId);
    this.emit({ type: "turn", roomId, running: false });
  }

  cancel(roomId: string): boolean {
    const entry = this.running.get(roomId);
    entry?.ctrl.abort();
    return entry !== undefined;
  }

  // 진행 중인 응답 연쇄가 끝날 때까지 (없으면 바로)
  idle(roomId: string): Promise<void> {
    return this.running.get(roomId)?.done ?? Promise.resolve();
  }

  // 모든 스트림을 멈추고 결과 저장까지 기다린다 (로그아웃 전)
  async cancelAll(): Promise<void> {
    const entries = [...this.running.values()];
    for (const e of entries) e.ctrl.abort();
    await Promise.all(entries.map((e) => e.done));
  }

  // 사용자 발화 1회의 응답 연쇄
  private async chain(room: Room, members: Agent[], text: string, defaultModel: string, ctrl: AbortController) {
    let lastModel = "";
    let firstReply = "";
    const taint = this.openTaint(room.id);
    const skill = this.invokedSkill(text);
    try {
      const byId = new Map(members.map((a) => [a.id, a]));
      const queue = (await this.firstSpeakers(room, members, text, defaultModel, ctrl.signal))
        .map((id) => byId.get(id))
        .filter((a): a is Agent => a !== undefined);
      for (let spoken = 0; spoken < room.chainLimit && queue.length > 0 && !ctrl.signal.aborted; spoken++) {
        const agent = queue.shift() as Agent;
        const reply = await this.reply({
          roomId: room.id,
          agent,
          members,
          query: text,
          defaultModel,
          ctrl,
          taint,
          skill,
        });
        if (reply.status !== "complete") break;
        lastModel = reply.model;
        firstReply ||= reply.content;
        // 답에서 부른 다른 참여자가 이어서 답한다 (자기 자신은 제외 → 같은 에이전트가 연달아 말하지 않음)
        if (members.length > 1)
          for (const id of findMentions(
            reply.content,
            members.filter((m) => m.id !== agent.id),
          ))
            if (!queue.some((q) => q.id === id)) queue.push(byId.get(id) as Agent);
      }
    } catch (err) {
      console.error("[chat] 응답 연쇄 예외", err);
    } finally {
      this.closeTaint(room.id, taint);
      this.end(room.id);
    }
    if (lastModel) void this.summaries.maybeUpdate(room.id, lastModel);
    if (lastModel) void this.autoTitle(room, text, firstReply, lastModel);
    this.tools.memory.noteActivity(room.id);
  }

  // 이름을 짓지 않은 방에 자동 제목. 실패해도 실행 중에 다시 시도하지 않는다 (답할 때마다 요청을 쓰지 않게)
  private async autoTitle(room: Room, user: string, reply: string, model: string) {
    const unnamed =
      isDefaultTitle(room.title) || (!!room.parentRoomId && room.title === defaultSubTitle(room.parentTitle));
    if (room.kind !== "chat" || !unnamed || this.titled.has(room.id) || !user.trim()) return;
    this.titled.add(room.id);
    const title = await makeTitle(this.llm, this.gate, model, user, reply);
    if (!title) return;
    // 그 사이 사용자가 이름을 바꿨으면 그대로 둔다
    const done = this.db
      .query("UPDATE rooms SET title = $title WHERE id = $id AND title = $old")
      .run({ id: room.id, title, old: room.title });
    if (done.changes) this.emit({ type: "rooms" });
  }

  // 첫 화자: 1인 방은 그 에이전트, 그룹은 @멘션 → 라우터 → 라운드로빈
  private async firstSpeakers(
    room: Room,
    members: Agent[],
    text: string,
    model: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (members.length === 1) return [members[0]?.id ?? ""];
    const mentioned = findMentions(text, members);
    if (mentioned.length > 0) return mentioned;
    const recent = this.summaries
      .context(room.id)
      .history.slice(-(ROUTER_CONTEXT + 1), -1) // 마지막은 방금 보낸 사용자 메시지
      .map((h) => ({ who: h.role === "user" ? "User" : `Agent ${this.agentName(h.agentId)}`, text: h.text }));
    const routed = await routeSpeakers(this.llm, this.gate, {
      members,
      recent,
      userText: text,
      max: room.chainLimit,
      model,
      signal,
    });
    if (routed) return routed;
    const last = this.lastAssistant(room.id);
    return [nextInTurn(room.agentIds, last) ?? members[0]?.id ?? ""];
  }

  // 다른 에이전트의 발화는 화자 태그를 붙인 인용 데이터로 넣는다. 1인 방에서도 (초대된 토론 참가자 등) 자기 말로 착각하지 않게
  // 바꾼 뒤 이력이 user 턴으로 시작하게 앞쪽 assistant 턴은 뺀다
  private turnsFor(
    agent: Agent,
    history: HistoryTurn[],
    group: boolean,
    files: Map<string, AttachmentRow[]> = new Map(),
  ): ChatTurn[] {
    const turns: ChatTurn[] = attachToTurns(
      history.map((h) =>
        h.role === "user" || h.agentId === agent.id || (!group && !h.agentId)
          ? { role: h.role, text: h.text }
          : { role: "user", text: agentMessage(this.agentName(h.agentId), h.text) },
      ),
      history.map((h) => (h.role === "user" ? h.id : "")),
      files,
    );
    while (turns.length > 0 && turns[0]?.role !== "user") turns.shift();
    return turns;
  }

  // 방에서 에이전트 한 명이 답한다 (메시지 생성·스트리밍·저장)
  private async reply(p: ReplyInput): Promise<Message> {
    const { roomId, agent, members, query, ctrl, taint, debate, lounge, proactive } = p;
    const model = agent.model || p.defaultModel;
    const group = members.length > 1 || debate !== undefined || lounge !== undefined;
    const { summary, history } = this.summaries.context(roomId);
    const own = p.memories ?? (await this.tools.memory.forTurn(agent, query));
    // 호출한 대화의 기억을 더한다 (겹치면 한 번)
    const memories = p.context ? [...own, ...p.context.memories.filter((m) => !own.some((o) => o.id === m.id))] : own;
    const path = [agent.id];
    const skills = p.noTools ? [] : this.skillsFor(agent, p.skill?.name);
    const mcp = p.noTools ? [] : this.mcpServersOf(agent);
    const instructions = buildInstructions({
      agentName: agent.name,
      role: agent.role,
      persona: this.agents.persona(agent.personaId)?.body ?? "",
      summary,
      hasTools: !p.noTools && this.toolsFor(agent, path, roomId, skills, mcp, !!taint.unattended).specs.length > 0,
      task: p.task ? { ...p.task, now: formatLocal(Date.now()) } : undefined,
      parentReference: this.reference(roomId) || undefined,
      mcp: mcp.length > 0,
      workspace: p.noTools ? undefined : this.workspaceHint(agent, roomId),
      skills: this.skillHint(skills, p.skill),
      memories: memories.map((m) => ({ kind: m.kind, text: m.contentEn || m.content, updatedAt: m.updatedAt })),
      group: group
        ? { others: members.filter((m) => m.id !== agent.id).map((m) => ({ name: m.name, role: m.role })) }
        : undefined,
      debate: debate?.part,
      workLog: p.context?.workLog,
      lounge,
      proactive,
      userInstructions: lounge ? "" : this.globalInstructions(),
    });
    const assistant: Message = {
      id: crypto.randomUUID(),
      roomId,
      role: "assistant",
      agentId: agent.id,
      content: "",
      status: "streaming",
      model,
      errorCode: "",
      recovery: "none",
      sources: [],
      memoryIds: memories.map((m) => m.id),
      debateId: debate?.id ?? "",
      debateRound: debate?.round ?? 0,
      proactive: proactive?.kind ?? (p.task ? "task" : ""),
      attachments: [],
      createdAt: this.stamp(),
    };
    this.insert(assistant);

    const state: TurnState = { taint, sources: [], approved: new Set() };
    const { content, result } = await this.runAgent({
      agent,
      model,
      instructions,
      turns: [
        ...this.turnsFor(agent, history, group, this.attachments.fullByMessage(roomId)),
        // 라운지 첫 발언: 사용자 메시지가 없으므로 새 세션이 시작됐다는 표시를 마지막 user 턴으로 (요청 입력이 비지 않게)
        ...(lounge?.step === "open" ? [{ role: "user" as const, text: LOUNGE_KICKOFF }] : []),
        // 선제 메시지: 사용자가 새로 쓴 말이 없으므로 표시 턴으로 요청이 user 로 끝나게
        ...(proactive ? [{ role: "user" as const, text: PROACTIVE_KICKOFF }] : []),
        ...(p.task ? [{ role: "user" as const, text: TASK_KICKOFF }] : []),
      ],
      roomId,
      messageId: assistant.id,
      parentId: "",
      path,
      signal: ctrl.signal,
      onDelta: (text) => this.emit({ type: "delta", roomId, messageId: assistant.id, text }),
      state,
      feature: debate ? "debate" : lounge ? "lounge" : proactive ? "proactive" : p.task ? "tasks" : "chat",
      noTools: p.noTools,
      skills,
      mcp,
    });

    this.finishStatus(agent.id, roomId, result, "답함");
    const status: MessageStatus = result.outcome === "completed" ? "complete" : content ? "partial" : "failed";
    const done: Message = {
      ...assistant,
      content,
      status,
      sources: state.sources,
      errorCode: result.outcome === "completed" ? "" : result.code || result.outcome,
      recovery: result.recovery,
    };
    this.db
      .query(
        `UPDATE messages SET content = $content, status = $status, error_code = $code, recovery = $recovery,
         sources = $sources WHERE id = $id`,
      )
      .run({
        content,
        status,
        code: done.errorCode,
        recovery: done.recovery,
        sources: JSON.stringify(done.sources),
        id: done.id,
      });
    this.emit({ type: "message", message: done });
    return done;
  }

  // ---- 토론·협업 ----

  debatesOf(roomId: string): Debate[] {
    return this.debates.list(roomId);
  }

  // 참가자는 방 참여자 중에서 (토론 뒤 @이름으로 이어 물을 수 있게), 진행자는 아무 에이전트
  startDebate(
    roomId: string,
    req: StartDebateInput,
    defaultModel: string,
  ): Debate | SendError | "not_member" | "budget" {
    const room = this.room(roomId);
    if (!room) return "not_found";
    if (this.running.has(roomId)) return "busy";
    // /debate·/collab 으로 연 토론은 방 밖 에이전트도 초대한다 (방 구성은 바꾸지 않음)
    if (!req.context && req.agentIds.some((id) => !room.agentIds.includes(id))) return "not_member";
    const participants = req.agentIds.map((id) => this.agents.agent(id)).filter((a): a is Agent => a !== null);
    const moderator = this.agents.agent(req.moderatorId);
    if (participants.length !== req.agentIds.length || !moderator) return "no_agent";
    if ([...participants, moderator].some((a) => !this.agents.persona(a.personaId))) return "no_agent";
    // 시작하기 전에 끝까지 갈 예산이 있는지 본다 (도구·위임 단계는 따로 셈)
    const left = this.gate.remaining("debate");
    if (left !== null && left < req.rounds * participants.length + 2) return "budget";

    const { context: withContext, ...fields } = req;
    // 맥락은 토론 메시지를 넣기 전에 만든다
    const context = withContext ? this.debateContext(room) : undefined;
    const debate = this.debates.create({ roomId, ...fields });
    this.emit({ type: "debate", debate });
    this.insert(this.userMessage(roomId, `${req.mode === "debate" ? "토론" : "협업"}: ${req.topic}`, debate.id));
    if (context) this.contextDebates.add(roomId);
    this.debatingRooms.add(roomId);
    this.begin(roomId, (ctrl) => this.runDebate(debate, participants, moderator, defaultModel, ctrl, context));
    return debate;
  }

  private debateContext(room: Room): DebateContext {
    const members = this.memberAgents(room);
    return {
      memories: this.tools.memory.fromRoom(room.id, members),
      workLog: workLog(this.tools.calls.list(room.id), (id) => this.agentName(id)),
    };
  }

  // 진행자 여는 말 → 라운드마다 참가자가 순서대로 → 진행자 맺는 말. 한 발언이라도 끝나지 못하면 멈춘다
  private async runDebate(
    start: Debate,
    participants: Agent[],
    moderator: Agent,
    defaultModel: string,
    ctrl: AbortController,
    context?: DebateContext,
  ) {
    let debate = start;
    const update = (patch: Parameters<DebateStore["update"]>[1]) => {
      debate = this.debates.update(debate, patch);
      this.emit({ type: "debate", debate });
    };
    const everyone = participants.some((a) => a.id === moderator.id) ? participants : [...participants, moderator];
    const taint = this.openTaint(debate.roomId, { debate: true });
    const steps: { agent: Agent; step: DebatePart["step"]; round: number }[] = [
      { agent: moderator, step: "open", round: 0 },
      ...Array.from({ length: debate.rounds }, (_, i) =>
        participants.map((agent) => ({ agent, step: "turn" as const, round: i + 1 })),
      ).flat(),
      { agent: moderator, step: "close", round: debate.rounds + 1 },
    ];
    let lastModel = "";
    let failure = "";
    try {
      for (const s of steps) {
        if (ctrl.signal.aborted) break;
        if (s.round !== debate.round) update({ round: s.round });
        const m = await this.reply({
          roomId: debate.roomId,
          agent: s.agent,
          members: everyone,
          query: debate.topic,
          defaultModel,
          ctrl,
          taint,
          context,
          debate: {
            id: debate.id,
            round: s.round,
            part: {
              mode: debate.mode,
              topic: debate.topic,
              step: s.step,
              round: s.round,
              rounds: debate.rounds,
              participants: participants.map((a) => a.name),
              moderator: moderator.name,
            },
          },
        });
        if (m.status !== "complete") {
          failure = m.errorCode || m.status;
          break;
        }
        lastModel = m.model;
      }
    } catch (err) {
      console.error("[chat] 토론 진행 예외", err);
      failure = "internal";
    } finally {
      const status = ctrl.signal.aborted ? "stopped" : failure ? "failed" : "done";
      update({ status, errorCode: status === "done" ? "" : failure || "cancelled" });
      this.contextDebates.delete(debate.roomId);
      this.debatingRooms.delete(debate.roomId);
      this.closeTaint(debate.roomId, taint);
      this.end(debate.roomId);
    }
    if (lastModel) void this.summaries.maybeUpdate(debate.roomId, lastModel);
  }

  // ---- 자율 대화 (라운지) ----

  anyRunning(): boolean {
    return this.running.size > 0;
  }

  // 대화에 마지막으로 쓴 모델 (전역 설정이 비었을 때)
  lastModel(): string {
    return lastUsedModel(this.db);
  }

  loungeRoom(): Room | null {
    const r = this.db.query<RoomRow, []>("SELECT * FROM rooms WHERE kind = 'lounge' ORDER BY created_at LIMIT 1").get();
    return r ? this.toRoom(r) : null;
  }

  // 라운지 방(없으면 만든다)의 참여자를 맞추고 세션을 시작한다. 다른 응답이 진행 중이면 미룬다 (사용자 대화 우선)
  startLounge(
    agentIds: string[],
    turns: number,
    defaultModel: string,
    manual: boolean,
    random: () => number = Math.random,
  ): LoungeSession | "busy" | "no_agents" | "budget" | "paused" {
    if (this.anyRunning()) return "busy";
    if (this.gate.status().paused) return "paused";
    const agents = agentIds
      .map((id) => this.agents.agent(id))
      .filter((a): a is Agent => a !== null && this.agents.persona(a.personaId) !== null);
    if (agents.length < 2) return "no_agents";
    const left = this.gate.remaining("lounge");
    if (left !== null && left < turns) return "budget";

    const ids = agents.map((a) => a.id);
    let room = this.loungeRoom();
    if (!room) {
      const created = this.createRoom("라운지", ids);
      if (typeof created === "string") return "no_agents";
      this.db.query("UPDATE rooms SET kind = 'lounge' WHERE id = $id").run({ id: created.id });
      room = this.room(created.id) as Room;
      this.emit({ type: "rooms" });
    } else if (room.agentIds.join() !== ids.join()) {
      this.setMembers(room.id, ids);
      this.emit({ type: "rooms" });
    }
    const session = this.lounges.create({ roomId: room.id, agentIds: ids, turns, manual }, Date.now());
    this.emit({ type: "lounge", session });
    this.begin(room.id, (ctrl) => this.runLounge(session, agents, defaultModel, ctrl, random));
    return session;
  }

  // 첫 화자가 주제를 꺼내고, 이후 직전 화자를 뺀 참가자 중 무작위로 이어 간다. 도구 없이, 공용 핵심 기억만
  private async runLounge(
    start: LoungeSession,
    agents: Agent[],
    defaultModel: string,
    ctrl: AbortController,
    random: () => number,
  ) {
    let session = start;
    const update = (patch: Parameters<LoungeStore["update"]>[1]) => {
      session = this.lounges.update(session, patch);
      this.emit({ type: "lounge", session });
    };
    const taint: Taint = { searched: false, debate: true };
    const memories = this.tools.memory.forLounge();
    let last = "";
    let lastModel = "";
    let failure = "";
    try {
      for (let i = 0; i < session.turns; i++) {
        if (ctrl.signal.aborted) break;
        const pool = agents.filter((a) => a.id !== last);
        const agent = pool[Math.floor(random() * pool.length)] ?? (agents[0] as Agent);
        const step: LoungePart["step"] = i === 0 ? "open" : i === session.turns - 1 ? "close" : "turn";
        const m = await this.reply({
          roomId: session.roomId,
          agent,
          members: agents,
          query: "",
          defaultModel,
          ctrl,
          taint,
          lounge: { step, participants: agents.map((a) => a.name) },
          noTools: true,
          memories,
        });
        if (m.status !== "complete") {
          failure = m.errorCode || m.status;
          break;
        }
        last = agent.id;
        lastModel = m.model;
        update({ spoken: i + 1 });
      }
    } catch (err) {
      console.error("[chat] 자율 대화 예외", err);
      failure = "internal";
    } finally {
      const status = ctrl.signal.aborted ? "stopped" : failure ? "failed" : "done";
      update({ status, errorCode: status === "done" ? "" : failure || "cancelled", endedAt: Date.now() });
      this.end(session.roomId);
    }
    if (lastModel) void this.summaries.maybeUpdate(session.roomId, lastModel);
    this.tools.memory.noteActivity(session.roomId); // 라운지 기억 추출은 설정이 켜져 있을 때만 (MemoryService)
  }

  // ---- 선제 메시지 ----

  // 그 에이전트 혼자 있는 가장 최근 일반 방 (없으면 만든다)
  soloRoom(agentId: string): Room | null {
    const r = this.db
      .query<RoomRow, { agent: string }>(
        `SELECT r.* FROM rooms r WHERE r.kind = 'chat'
           AND (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) = 1
           AND EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id AND m.agent_id = $agent)
         ORDER BY r.updated_at DESC LIMIT 1`,
      )
      .get({ agent: agentId });
    if (r) return this.toRoom(r);
    const agent = this.agents.agent(agentId);
    if (!agent) return null;
    const created = this.createRoom(`새 채팅 (${agent.name})`, [agentId]);
    if (typeof created === "string") return null;
    this.emit({ type: "rooms" });
    return created;
  }

  // 사용자가 마지막으로 말한 일반 방과 시각 (라운지·토론 제외)
  lastUserActivity(): { roomId: string; at: number } | null {
    const r = this.db
      .query<{ room_id: string; created_at: number }, []>(
        `SELECT m.room_id, m.created_at FROM messages m JOIN rooms r ON r.id = m.room_id
         WHERE m.role = 'user' AND r.kind = 'chat' AND m.debate_id = '' ORDER BY m.created_at DESC LIMIT 1`,
      )
      .get();
    return r ? { roomId: r.room_id, at: r.created_at } : null;
  }

  // 방의 마지막 화자 (없으면 첫 참여자)
  lastSpeaker(roomId: string): string {
    const room = this.room(roomId);
    const last = this.lastAssistant(roomId);
    return room?.agentIds.includes(last) ? last : (room?.agentIds[0] ?? "");
  }

  // LLM 없이 정해진 문구로 남긴다 (예산·한도로 생성할 수 없을 때의 리마인더). 방이 응답 중이면 false
  postProactive(roomId: string, agentId: string, kind: Message["proactive"], content: string): boolean {
    const room = this.room(roomId);
    if (!room || this.running.has(roomId)) return false;
    const speaker = room.agentIds.includes(agentId) ? agentId : (room.agentIds[0] ?? "");
    this.insert({
      ...this.userMessage(roomId, content),
      role: "assistant",
      agentId: speaker,
      proactive: kind,
    });
    return true;
  }

  // 에이전트가 먼저 말을 건다 (도구 없이). 방이 응답 중이면 "busy" — 스케줄러가 다음에 다시.
  // fallback: 생성에 실패해 내용이 없으면 이 문구로 남긴다 (리마인더를 잃지 않게)
  startProactive(p: {
    roomId: string;
    agentId: string;
    part: ProactivePart;
    defaultModel: string;
    query: string;
    fallback?: string;
  }): Promise<Message | null> | "busy" | "not_found" | "paused" {
    const room = this.room(p.roomId);
    if (!room) return "not_found";
    if (this.running.has(room.id)) return "busy";
    if (this.gate.status().paused) return "paused";
    const members = this.memberAgents(room);
    // 예약한 에이전트가 지워졌거나 방을 나갔으면 첫 참여자가 대신
    const agent = members.find((a) => a.id === p.agentId) ?? members[0];
    if (!agent || !this.agents.persona(agent.personaId)) return "not_found";
    let resolve: (m: Message | null) => void = () => {};
    const out = new Promise<Message | null>((r) => {
      resolve = r;
    });
    this.begin(room.id, async (ctrl) => {
      let m: Message | null = null;
      try {
        m = await this.reply({
          roomId: room.id,
          agent,
          members,
          query: p.query,
          defaultModel: p.defaultModel,
          ctrl,
          taint: { searched: false, debate: false },
          proactive: p.part,
          noTools: true,
        });
        if (m.status === "failed" && p.fallback) {
          m = { ...m, content: p.fallback, status: "complete", errorCode: "", recovery: "none" };
          this.db
            .query(
              "UPDATE messages SET content = $content, status = 'complete', error_code = '', recovery = 'none' WHERE id = $id",
            )
            .run({ content: m.content, id: m.id });
          this.emit({ type: "message", message: m });
        }
      } catch (err) {
        console.error("[chat] 선제 메시지 예외", err);
      } finally {
        this.end(room.id);
        resolve(m);
      }
      if (m?.status === "complete" && m.model) void this.summaries.maybeUpdate(room.id, m.model);
    });
    return out;
  }

  /**
   * 예약 작업 한 번 실행 (P8): 고른 방에서 그 에이전트가 도구를 써서 하고 보고를 남긴다.
   * 방이 응답 중이면 "busy" (스케줄러가 잠시 뒤 다시). 결과 메시지는 proactive 'task'
   */
  startTask(p: {
    roomId: string;
    agentId: string;
    title: string;
    prompt: string;
    allowedTools: string[];
    defaultModel: string;
  }): Promise<TaskOutcome> | "busy" | "not_found" | "paused" {
    const room = this.room(p.roomId);
    if (!room) return "not_found";
    if (this.running.has(room.id)) return "busy";
    if (this.gate.status().paused) return "paused";
    const members = this.memberAgents(room);
    const agent = members.find((a) => a.id === p.agentId);
    if (!agent || !this.agents.persona(agent.personaId)) return "not_found";
    const unattended: Unattended = { allowed: p.allowedTools, requests: 0, rejected: 0 };
    const taint = this.openTaint(room.id, { unattended });
    let resolve: (r: TaskOutcome) => void = () => {};
    const out = new Promise<TaskOutcome>((r) => {
      resolve = r;
    });
    this.begin(room.id, async (ctrl) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, this.taskTimeoutMs);
      let m: Message | null = null;
      try {
        m = await this.reply({
          roomId: room.id,
          agent,
          members,
          query: `${p.title}\n${p.prompt}`,
          defaultModel: p.defaultModel,
          ctrl,
          taint,
          task: { title: p.title, prompt: p.prompt },
        });
      } catch (err) {
        console.error("[chat] 예약 작업 예외", err);
      } finally {
        this.closeTaint(room.id, taint);
        clearTimeout(timer);
        this.end(room.id);
      }
      const status: TaskOutcome["status"] =
        m?.status === "complete" ? "done" : ctrl.signal.aborted && !timedOut ? "cancelled" : "failed";
      resolve({
        status,
        reason: timedOut ? "timeout" : status === "done" ? "" : (m?.errorCode ?? "error"),
        messageId: m?.id ?? "",
        requests: unattended.requests,
        rejected: unattended.rejected,
      });
      if (m?.status === "complete" && m.model) void this.summaries.maybeUpdate(room.id, m.model);
    });
    return out;
  }

  taskTimeoutMs = TASK_TIMEOUT_MS;

  // ---- 오염 표시 ----

  private readonly carriedTaint = new Map<string, NonNullable<Taint["carried"]>>();

  private openTaint(roomId: string, base: Partial<Taint> = {}): Taint {
    const carried = this.carriedTaint.get(roomId);
    this.carriedTaint.delete(roomId);
    return { searched: false, debate: false, carried, ...base };
  }

  // 이번 턴에 직접 들어온 것만 넘긴다 (이어받은 표시는 한 턴으로 끝난다)
  private closeTaint(roomId: string, t: Taint) {
    const level = t.searched || t.external || t.debate ? "outside" : t.workspace ? "workspace" : null;
    if (level) this.carriedTaint.set(roomId, level);
  }

  // ---- 도구 ----

  toolCalls(roomId: string): ToolCall[] {
    return this.tools.calls.list(roomId);
  }

  pendingCalls(): ToolCall[] {
    return this.tools.calls.pending();
  }

  // 확인 대기 중인 쓰기 도구에 대한 결정. 대기 중이 아니면 false.
  // always: 이 호출을 한 에이전트(위임 하위면 하위 에이전트)의 이 도구를 '항상 허용'에 더한다 (사용자 결정 2026-10-29)
  decide(callId: string, approve: boolean, always = false): boolean {
    const found = approve && always ? this.tools.calls.get(callId) : null;
    const call = found && !this.tools.registry.alwaysConfirm(found.name) ? found : null;
    if (!this.tools.approvals.decide(callId, approve)) return false;
    if (call && this.agents.allowTool(call.agentId, call.name)) this.emit({ type: "agents" });
    return true;
  }

  // '항상 허용' 해제. 없는 에이전트면 null
  revokeTool(agentId: string, tool: string): Agent | null {
    const a = this.agents.revokeTool(agentId, tool);
    if (a) this.emit({ type: "agents" });
    return a;
  }

  private emitCall(call: ToolCall): ToolCall {
    this.emit({ type: "tool", call });
    return call;
  }

  // 이 실행에서 쓸 도구. 위임은 깊이 상한 안에서, 경로에 없는 에이전트에게만 (모든 에이전트 대상 — 사용자 결정)
  private toolsFor(
    agent: Agent,
    path: string[],
    roomId: string,
    skills: string[],
    mcp: string[],
    unattended = false,
  ): { specs: ToolSpec[]; delegates: Map<string, Agent> } {
    const delegates =
      path.length <= MAX_DELEGATION_DEPTH
        ? labelAgents(this.agents.agents().filter((a) => !path.includes(a.id)))
        : new Map<string, Agent>();
    const list = [...delegates].map(([label, a]) => ({ label, role: a.role }));
    const scope = {
      workspace: this.workspaceOf(roomId),
      skills,
      mcp,
      unattended,
      memoryReadonly: this.memoryReadonly(roomId),
    };
    return { specs: this.tools.registry.specsFor(agent, list, path.length > 1, scope), delegates };
  }

  // 도구 호출 하나를 처리하고 모델에 돌려줄 결과(JSON 문자열)를 만든다
  private async handleCall(fc: Record<string, unknown>, r: AgentRun, delegates: Map<string, Agent>): Promise<string> {
    const name = typeof fc.name === "string" ? fc.name : "";
    const args = typeof fc.arguments === "string" ? fc.arguments : "{}";
    const info = this.tools.registry.get(name);
    const workspace = this.workspaceOf(r.roomId);
    const allowed =
      info !== undefined &&
      (r.agent.tools.includes(name) ||
        (this.tools.registry.isSkillTool(name) && r.skills.length > 0) ||
        this.tools.registry.isMcpTool(name)) &&
      (!r.worker || r.worker.tools.has(name)) &&
      (name !== WORKERS_TOOL || (r.path.length === 1 && !r.worker)) &&
      (name !== DELEGATE_TOOL || delegates.size > 0) &&
      !(r.path.length > 1 && this.tools.registry.topLevelOnly(name)) &&
      this.tools.registry.usable(name, {
        workspace,
        skills: r.skills,
        mcp: r.mcp,
        unattended: !!r.state.taint.unattended,
        memoryReadonly: this.memoryReadonly(r.roomId),
      });
    const kind = info?.kind ?? "read";
    // 웹 검색 결과·토론·명령 출력이 들어간 턴에서는 '항상 허용'·확인 없는 도구여도 쓰기를 확인받는다 (조작 방지).
    // 파일 내용만 들어간 턴은 폴더 밖으로 이어지는 쓰기만
    const t = r.state.taint;
    const outside = t.searched || !!t.external || t.carried === "outside";
    const tainted =
      outside || t.debate || ((!!t.workspace || t.carried === "workspace") && !this.tools.registry.inWorkspace(name));
    const ctx = { agent: r.agent, roomId: r.roomId, workspace, signal: r.signal, skills: r.skills };
    // 승인 전에 할 일을 확정한다 (파일 diff·명령 요약). 준비가 안 되면 바로 실패로 모델에 알린다
    const prepared = allowed ? this.tools.registry.prepare(name, args, ctx) : null;
    // 규칙은 다시 읽는다 (같은 턴에서 방금 '항상 허용'한 도구도 바로 적용)
    // MCP 도구는 도구별 '항상 허용'만 (에이전트의 '모든 쓰기 확인 없이'는 적용 안 함 — 사용자 결정 2026-10-29)
    const mcpTool = this.tools.registry.isMcpTool(name);
    const autoOk =
      (!mcpTool && (r.agent.autoApproveWrites || this.tools.registry.trusted(name))) ||
      (this.agents.agent(r.agent.id)?.autoApproveTools.includes(name) ?? false) ||
      (!!r.worker && r.state.approved.has(name));
    // 예약 작업(사용자 없음): 기다리지 않는다. 쓰기는 미리 허용했고 늘 확인 도구가 아니며 오염되지 않았을 때만
    const un = t.unattended;
    const unattendedDenied =
      !!un &&
      allowed &&
      kind === "write" &&
      prepared?.ok !== false &&
      (!un.allowed.includes(name) || this.tools.registry.alwaysConfirm(name) || tainted);
    const needsApproval =
      !un &&
      allowed &&
      kind === "write" &&
      prepared?.ok !== false &&
      (this.tools.registry.alwaysConfirm(name) || !autoOk || tainted);
    let call = this.emitCall(
      this.tools.calls.create({
        roomId: r.roomId,
        messageId: r.messageId,
        agentId: r.agent.id,
        parentId: r.parentId,
        name,
        args,
        kind,
        status: needsApproval ? "pending" : "running",
        preview: prepared?.ok ? prepared.preview : "",
      }),
    );
    const finish = (patch: Partial<Pick<ToolCall, "status" | "output" | "reason">>) =>
      (call = this.emitCall(this.tools.calls.update(call, patch)));

    if (!allowed) {
      const output = JSON.stringify({ error: `tool not available: ${name}` });
      finish({ status: "failed", output, reason: "not_allowed" });
      return output;
    }
    if (prepared && !prepared.ok) {
      finish({ status: "failed", output: prepared.output, reason: "error" });
      return prepared.output;
    }
    if (un && unattendedDenied) {
      un.rejected++;
      const output = JSON.stringify({ error: UNATTENDED_DENIED });
      finish({ status: "denied", output, reason: "unattended" });
      return output;
    }
    const title = info?.title ?? name;
    if (needsApproval) {
      this.setStatus(r.agent.id, "waiting", `확인 필요 · ${title}`, r.roomId);
      const d = await this.tools.approvals.wait(call.id, r.signal, this.tools.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS);
      if (d !== "approve") {
        const message = {
          deny: "The user denied this action. Do not retry it; tell the user it was not done.",
          timeout: "The user did not respond in time, so this action was not done.",
          cancelled: "The turn was cancelled; this action was not done.",
        }[d];
        const output = JSON.stringify({ error: message });
        finish({ status: "denied", output, reason: d });
        return output;
      }
      finish({ status: "running" });
      // 방의 화자가 받은 허용은 이번 답의 작업자가 물려받는다
      if (!r.worker && r.path.length === 1) r.state.approved.add(name);
    }
    if (name !== DELEGATE_TOOL && name !== WORKERS_TOOL)
      this.setStatus(r.agent.id, "working", `${title} 실행 중`, r.roomId);
    const res =
      name === DELEGATE_TOOL
        ? await this.delegate(args, r, delegates, call.id)
        : name === WORKERS_TOOL
          ? await this.runWorkers(args, r, call.id)
          : await this.tools.registry.run(
              name,
              args,
              {
                ...ctx,
                workspace: this.workspaceOf(r.roomId),
                callId: call.id,
                messageId: call.messageId,
                outside,
              },
              prepared?.ok ? prepared.state : undefined,
            );
    const taints = this.tools.registry.taints(name);
    if (taints) r.state.taint[taints] = true;
    finish({ status: res.ok ? "done" : "failed", output: res.output, reason: res.ok ? "" : "error" });
    return res.output;
  }

  // 위임: 대상 에이전트를 격리된 컨텍스트(방 이력 없이 맡긴 일만)로 한 번 실행하고 답만 돌려준다
  private async delegate(
    rawArgs: string,
    parent: AgentRun,
    delegates: Map<string, Agent>,
    callId: string,
  ): Promise<{ ok: boolean; output: string }> {
    const fail = (error: string) => ({ ok: false, output: JSON.stringify({ error }) });
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      return fail("arguments are not valid JSON");
    }
    const a = DelegateArgs.safeParse(parsed);
    if (!a.success) return fail(`invalid arguments: ${a.error.issues[0]?.message ?? ""}`);
    const target = delegates.get(a.data.agent);
    if (!target || parent.path.includes(target.id)) return fail(`cannot delegate to: ${a.data.agent}`);

    const path = [...parent.path, target.id];
    this.setStatus(parent.agent.id, "working", `${target.name}에게 맡기는 중`, parent.roomId);
    const memories = await this.tools.memory.forTurn(target, a.data.task);
    const skills = this.skillsFor(target); // 위임 받은 실행은 그 에이전트가 켠 skill 만
    const mcp = this.mcpServersOf(target);
    const instructions = buildInstructions({
      agentName: target.name,
      role: target.role,
      persona: this.agents.persona(target.personaId)?.body ?? "",
      summary: "",
      hasTools:
        this.toolsFor(target, path, parent.roomId, skills, mcp, !!parent.state.taint.unattended).specs.length > 0,
      mcp: mcp.length > 0,
      workspace: this.workspaceHint(target, parent.roomId),
      skills: this.skillHint(skills),
      memories: memories.map((m) => ({ kind: m.kind, text: m.contentEn || m.content, updatedAt: m.updatedAt })),
      delegatedBy: parent.agent.name,
      userInstructions: this.globalInstructions(),
    });
    const sub = await this.runAgent({
      agent: target,
      model: target.model || parent.model,
      instructions,
      turns: [{ role: "user", text: `Task from agent "${parent.agent.name}":\n${fence("task", a.data.task)}` }],
      roomId: parent.roomId,
      messageId: parent.messageId,
      parentId: callId,
      path,
      signal: parent.signal,
      onDelta: () => {},
      state: parent.state,
      feature: "delegate",
      skills,
      mcp,
    });
    this.finishStatus(target.id, parent.roomId, sub.result, `${parent.agent.name}에게 맡은 일 끝냄`);
    if (sub.result.outcome !== "completed" && !sub.content)
      return fail(`the agent could not finish (${sub.result.code || sub.result.outcome})`);
    return {
      ok: true,
      output: truncate(
        JSON.stringify({
          agent: target.name,
          result: sub.content,
          ...(sub.result.outcome === "completed" ? {} : { note: "The answer was cut off and may be incomplete." }),
        }),
      ),
    };
  }

  /**
   * 임시 작업자 (P9a): 맡긴 일만 들고 동시에 실행한다 (대화 이력·페르소나·기억 없음). 도구는 부모가 이 실행에서 쓸 수 있는 것 중
   * 고른 것만 (작업자·위임·예약 작업 도구는 줄 수 없음). 승인은 부모 규칙 + 이번 답에서 부모가 받은 허용
   */
  private async runWorkers(
    rawArgs: string,
    parent: AgentRun,
    callId: string,
  ): Promise<{ ok: boolean; output: string }> {
    const fail = (error: string) => ({ ok: false, output: JSON.stringify({ error }) });
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      return fail("arguments are not valid JSON");
    }
    const a = WorkersArgs.safeParse(parsed);
    if (!a.success) return fail(`invalid arguments: ${a.error.issues[0]?.message ?? ""}`);

    // 부모가 지금 쓸 수 있는 도구 (함수 도구 이름 + 웹 검색은 "web_search")
    const parentTools = new Set(
      this.toolsFor(
        parent.agent,
        parent.path,
        parent.roomId,
        parent.skills,
        parent.mcp,
        !!parent.state.taint.unattended,
      ).specs.map((s) => (s.type === "function" ? s.name : s.type)),
    );
    const path = [...parent.path, parent.agent.id]; // 깊이 > 1: 방에서만 쓰는 도구는 숨는다
    this.setStatus(parent.agent.id, "working", `작업자 ${a.data.workers.length}명 실행 중`, parent.roomId);

    const results = await Promise.all(
      a.data.workers.map(async (w) => {
        const tools = new Set(w.tools.filter((t) => parentTools.has(t) && !WORKER_FORBIDDEN(t)));
        const ignored = w.tools.filter((t) => !tools.has(t));
        let row = this.emitCall(
          this.tools.calls.create({
            roomId: parent.roomId,
            messageId: parent.messageId,
            agentId: parent.agent.id,
            parentId: callId,
            name: WORKER_CALL,
            args: JSON.stringify({ title: w.title, task: w.task, tools: [...tools] }),
            kind: "read",
            status: "running",
            preview: "",
          }),
        );
        const instructions = buildInstructions({
          agentName: `${parent.agent.name} worker`,
          role: "",
          persona: "",
          summary: "",
          hasTools: tools.size > 0,
          mcp: [...tools].some((t) => this.tools.registry.isMcpTool(t)),
          workspace: this.workspaceHint(parent.agent, parent.roomId),
          workerOf: parent.agent.name,
          userInstructions: this.globalInstructions(),
        });
        const sub = await this.runAgent({
          agent: parent.agent,
          model: parent.model,
          instructions,
          turns: [{ role: "user", text: fence("task", w.task) }],
          roomId: parent.roomId,
          messageId: parent.messageId,
          parentId: row.id,
          path,
          signal: parent.signal,
          onDelta: () => {},
          state: parent.state,
          feature: "delegate",
          skills: parent.skills,
          mcp: parent.mcp,
          worker: { tools },
        });
        const done = sub.result.outcome === "completed";
        const result =
          sub.content.length > WORKER_RESULT_MAX
            ? `${sub.content.slice(0, WORKER_RESULT_MAX)}…(truncated)`
            : sub.content;
        const out = {
          title: w.title,
          status: done ? "done" : sub.result.outcome === "cancelled" ? "cancelled" : "failed",
          result: result || (done ? "" : `could not finish (${sub.result.code || sub.result.outcome})`),
          ...(ignored.length ? { ignored_tools: ignored } : {}),
        };
        row = this.emitCall(
          this.tools.calls.update(row, {
            status: done ? "done" : "failed",
            output: JSON.stringify(out),
            reason: done ? "" : "error",
          }),
        );
        return out;
      }),
    );
    this.setStatus(parent.agent.id, "working", "작업자 결과 정리 중", parent.roomId);
    return {
      ok: results.some((r) => r.status === "done"),
      output: truncate(JSON.stringify({ workers: results }), WORKERS_OUTPUT_MAX),
    };
  }

  // 한 실행: 응답 → (도구 호출이 있으면) 실행 → 결과를 붙여 다시 요청 … 도구 호출이 없을 때까지, 최대 MAX_TOOL_STEPS
  private async runAgent(r: AgentRun): Promise<{ content: string; result: StreamResult }> {
    let content = "";
    let result: StreamResult = failedResult("internal", "unknown");
    const { specs, delegates } = r.noTools
      ? { specs: [], delegates: new Map<string, Agent>() }
      : this.toolsFor(r.agent, r.path, r.roomId, r.skills, r.mcp, !!r.state.taint.unattended);
    // 작업자: 고른 도구만 (웹 검색은 "web_search" 로 고른다 — 결과는 공유 오염으로 이후 쓰기를 다시 확인)
    const shown = r.worker ? specs.filter((s) => r.worker?.tools.has(s.type === "function" ? s.name : s.type)) : specs;
    const items: Record<string, unknown>[] = []; // store:false 라 이전 단계의 출력·도구 결과를 매번 다시 보낸다
    let needBreak = false; // 단계 사이 텍스트를 문단으로 나눈다
    let speaking = false;
    const onDelta = (text: string) => {
      if (!speaking) {
        speaking = true;
        this.setStatus(r.agent.id, "working", r.parentId ? "맡은 일 하는 중" : "답하는 중", r.roomId);
      }
      if (needBreak && content) {
        content += "\n\n";
        r.onDelta("\n\n");
      }
      needBreak = false;
      content += text;
      r.onDelta(text);
    };
    // 내장 웹 검색: 끝나고 글이 나오면 onDelta 가 다시 '답하는 중'으로 바꾼다
    const onSearch = () => {
      speaking = false;
      this.setStatus(r.agent.id, "working", "웹 검색 실행 중", r.roomId);
    };
    try {
      for (let step = 0; ; step++) {
        if (step >= MAX_TOOL_STEPS) {
          result = failedResult("tool_loop_limit", "none");
          break;
        }
        speaking = false;
        this.setStatus(r.agent.id, "thinking", r.parentId ? "맡은 일 생각 중" : "생각 중", r.roomId);
        if (r.state.taint.unattended) r.state.taint.unattended.requests++;
        result = await this.gate.run(r.feature, r.model, () =>
          this.llm.stream(
            {
              model: r.model,
              instructions: r.instructions,
              turns: r.turns,
              items,
              // 내장 검색은 실행 전에 확인받을 수 없어, 파일을 읽은 뒤에는 검색어로 내용이 나가지 않게 뺀다 (사용자 결정 2026-11-01)
              tools: r.state.taint.workspace ? shown.filter((s) => s.type !== "web_search") : shown,
              reasoningEffort: r.agent.reasoningEffort || undefined, // "" = 자동 (모델 기본값)
            },
            { signal: r.signal, onDelta, onSearch },
          ),
        );
        if (result.outcome !== "completed") break;
        for (const s of citationsOf(result.items))
          if (!r.state.sources.some((x) => x.url === s.url)) r.state.sources.push(s);
        if (result.items.some((i) => i.type === "web_search_call")) r.state.taint.searched = true;
        const calls = result.items.filter((i) => i.type === "function_call");
        if (calls.length === 0) break;

        items.push(...result.items); // 받은 그대로 (실계정 확인: message·function_call 항목 재전송 허용)
        for (const fc of calls) {
          if (r.signal.aborted) break; // 중지 뒤에는 남은 호출을 실행하지 않는다 (자동 허용 쓰기 포함)
          const output = await this.handleCall(fc, r, delegates);
          items.push({ type: "function_call_output", call_id: fc.call_id, output });
        }
        if (r.signal.aborted) {
          result = { ...failedResult("cancelled", "none"), outcome: "cancelled" };
          break;
        }
        needBreak = true;
      }
    } catch (err) {
      console.error("[chat] 실행 예외", err);
      result = failedResult("internal", "unknown");
    }
    return { content, result };
  }
}
