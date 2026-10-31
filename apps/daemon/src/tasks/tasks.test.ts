// 반복 예약 작업: 저장 검사, 스케줄러(놓친 회차·예산·방 응답 중), 무인 승인(허용·거절·오염·늘 확인·위임), task_* 숨김
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  AgentInput,
  type Budgets,
  DEFAULT_BUDGETS,
  SETTINGS_DEFAULTS,
  type ServerEvent,
  type ToolCall,
} from "@proprix/shared";
import type { AiRequest } from "@proprix/siwc";
import { AgentStore, DEFAULT_PERSONA_ID } from "../agents/store";
import type { StreamOptions, StreamResult } from "../auth/account";
import { ChatService } from "../chat/chat";
import { makeChatTools } from "../chat/test-helpers";
import { SummaryService } from "../context/summary";
import { LlmGate } from "../llm/gate";
import { migrate } from "../storage/db";
import { TaskScheduler } from "./scheduler";
import { TaskStore } from "./store";

const fc = (name: string, args: object, id = name) => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: `call_${id}`,
  name,
  arguments: JSON.stringify(args),
  status: "completed",
});
const outputs = (req: AiRequest) => (req.items ?? []).filter((i) => i.type === "function_call_output").length;

function setup(
  script: (req: AiRequest) => Record<string, unknown>[] | null,
  opt: {
    budgets?: Partial<Budgets>;
    tools?: string[];
    now?: () => number;
    slow?: () => Promise<void>;
    workspace?: boolean; // 작업 폴더 도구를 켠다
  } = {},
) {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const requests: AiRequest[] = [];
  const llm = {
    async stream(req: AiRequest, o: StreamOptions): Promise<StreamResult> {
      requests.push(structuredClone(req));
      await opt.slow?.();
      const items = script(req) ?? [];
      if (!items.length) o.onDelta("보고");
      return {
        outcome: "completed",
        code: "",
        param: "",
        recovery: "none",
        http: 200,
        attempts: 1,
        chars: 0,
        requestId: "",
        items: items.length
          ? items
          : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "보고", annotations: [] }] }],
      };
    },
  };
  const events: ServerEvent[] = [];
  const emit = (e: ServerEvent) => events.push(e);
  const budgets: Budgets = { ...DEFAULT_BUDGETS, ...opt.budgets };
  const gate = new LlmGate(
    db,
    () => {},
    2,
    () => budgets,
  );
  const agents = new AgentStore(db);
  const summaries = new SummaryService(db, llm, gate, emit, () => "a");
  const now = opt.now ?? Date.now;
  const store = new TaskStore(db, now);
  const tools = makeChatTools(db, llm, gate, agents, emit, {
    tasks: store,
    snapshotsDir: opt.workspace ? mkdtempSync(join(tmpdir(), "proprix-task-snap-")) : undefined,
  });
  const chat = new ChatService(db, llm, gate, agents, summaries, tools, emit);
  const mk = (name: string) =>
    agents.createAgent(
      AgentInput.parse({
        personaId: DEFAULT_PERSONA_ID,
        name,
        tools: opt.tools ?? ["note_create", "memory_save", "task_create", "delegate_to_agent"],
      }),
    ) as Agent;
  const agent = mk("작업봇");
  const helper = mk("도우미");
  const room = chat.createRoom("t", [agent.id]);
  if (typeof room === "string") throw new Error(room);
  store.checks.agentInRoom = (a, r) => chat.room(r)?.agentIds.includes(a) ?? false;
  const settings = () => ({ ...SETTINGS_DEFAULTS, model: "m" });
  const scheduler = new TaskScheduler(store, chat, gate, settings, { tickMs: 1000, missMs: 10 * 60_000, now });
  const calls = () =>
    events.filter((e): e is Extract<ServerEvent, { type: "tool" }> => e.type === "tool").map((e) => e.call);
  const final = (name: string): ToolCall | undefined => calls().findLast((c) => c.name === name);
  return { db, store, chat, scheduler, room, agent, helper, agents, requests, calls, final, events };
}

const task = (s: ReturnType<typeof setup>, patch: Record<string, unknown> = {}) => {
  const t = s.store.create({
    title: "아침 정리",
    prompt: "메모를 정리해 보고해",
    agentId: s.agent.id,
    roomId: s.room.id,
    schedule: { kind: "daily", time: "09:00" },
    ...patch,
  });
  if ("error" in t) throw new Error(t.message);
  return t;
};
// 지금 실행할 차례로 만든다
const dueNow = (s: ReturnType<typeof setup>, id: string, at = Date.now()) =>
  s.db.query("UPDATE tasks SET next_run_at = $at WHERE id = $id").run({ id, at });

test("저장 검사: 1시간 미만 cron·방에 없는 에이전트·허용할 수 없는 도구 거부, 다음 실행 계산, N시간 기준 유지", () => {
  const s = setup(() => null);
  s.store.checks.toolError = (_a, tool) => (tool === "shell_run" ? "명령 실행은 안 됨" : "");
  expect(
    s.store.create({
      title: "x",
      prompt: "y",
      agentId: s.agent.id,
      roomId: s.room.id,
      schedule: { kind: "cron", cron: "*/10 * * * *" },
    }),
  ).toMatchObject({ error: "invalid" });
  expect(
    s.store.create({
      title: "x",
      prompt: "y",
      agentId: s.helper.id,
      roomId: s.room.id,
      schedule: { kind: "daily", time: "09:00" },
    }),
  ).toMatchObject({ error: "invalid" });
  expect(task.bind(null, s, { allowedTools: ["shell_run"] })).toThrow("명령 실행");
  const t = task(s);
  expect(t.nextRunAt).toBeGreaterThan(Date.now());
  expect(t.scheduleText).toBe("매일 09:00");
  const iv = task(s, { schedule: { kind: "interval", hours: 3 } });
  const anchor = (iv.schedule as { anchor: number }).anchor;
  const upd = s.store.update(iv.id, { ...iv, title: "바꿈", schedule: { kind: "interval", hours: 3 } });
  expect((upd as { schedule: { anchor: number } }).schedule.anchor).toBe(anchor);
});

test("놓친 회차는 실행하지 않고 기록 하나만 남긴 뒤 다음 회차로", async () => {
  const s = setup(() => null);
  const t = task(s);
  dueNow(s, t.id, Date.now() - 3 * 86_400_000); // 사흘 전 (PC 꺼짐)
  await s.scheduler.tick();
  expect(s.requests).toHaveLength(0);
  const runs = s.store.runs(t.id);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ status: "skipped", reason: "missed" });
  expect(s.store.get(t.id)?.nextRunAt).toBeGreaterThan(Date.now());
});

test("실행: 결과 메시지는 task 표시, 지시는 instructions 에, 요청 수 기록, 허용 도구는 바로 · 허용하지 않은 쓰기는 대기 없이 거절, task_* 는 숨김", async () => {
  const s = setup((req) => {
    const n = outputs(req);
    if (n === 0) return [fc("note_create", { title: "요약", body: "내용" }, "a")];
    if (n === 1)
      return [
        fc("memory_save", { kind: "fact", scope: "shared", content: "x", content_en: "x", importance: null }, "b"),
      ];
    return null;
  });
  const t = task(s, { allowedTools: ["note_create"] });
  dueNow(s, t.id);
  await s.scheduler.tick();
  const run = s.store.runs(t.id)[0];
  expect(run).toMatchObject({ status: "done", requests: 3, rejected: 1 });
  expect(s.final("note_create")?.status).toBe("done");
  expect(s.final("memory_save")).toMatchObject({ status: "denied", reason: "unattended" });
  expect(s.calls().some((c) => c.status === "pending")).toBe(false);
  const req = s.requests[0];
  expect(req?.instructions).toContain(
    '# Scheduled task (set up by the user)\nThis is a scheduled run of the task "아침 정리"',
  );
  expect(req?.instructions).toContain("메모를 정리해 보고해");
  expect((req?.tools ?? []).map((x) => (x.type === "function" ? x.name : x.type))).not.toContain("task_create");
  const msg = s.chat.messages(s.room.id).find((m) => m.id === run?.messageId);
  expect(msg).toMatchObject({ role: "assistant", proactive: "task", status: "complete" });
  expect(s.store.messages(s.room.id)).toEqual([{ messageId: run?.messageId ?? "", taskId: t.id, title: "아침 정리" }]);
  expect(s.store.get(t.id)).toMatchObject({ lastStatus: "done" });
});

test("웹 검색 결과가 들어간 뒤에는 미리 허용한 쓰기도 거절", async () => {
  const s = setup((req) =>
    outputs(req) === 0
      ? [{ type: "web_search_call", id: "ws1", status: "completed" }, fc("note_create", { title: "t", body: "b" }, "w")]
      : null,
  );
  const t = task(s, { allowedTools: ["note_create"] });
  expect(s.scheduler.runNow(t.id)).toBeInstanceOf(Promise);
  await s.chat.idle(s.room.id);
  await Bun.sleep(10);
  expect(s.final("note_create")).toMatchObject({ status: "denied", reason: "unattended" });
  expect(s.store.runs(t.id)[0]).toMatchObject({ scheduledFor: null, rejected: 1 });
});

test("위임 받은 하위 실행에도 무인 규칙이 이어진다", async () => {
  const s = setup((req) => {
    const delegated = (req.turns ?? []).some((x) => x.role === "user" && x.text.startsWith("Task from agent"));
    if (delegated)
      return outputs(req) === 0
        ? [fc("memory_save", { kind: "fact", scope: "shared", content: "y", content_en: "y", importance: null }, "sub")]
        : null;
    return outputs(req) === 0 ? [fc("delegate_to_agent", { agent: "도우미", task: "기억해 둬" }, "d")] : null;
  });
  const t = task(s, { allowedTools: ["note_create"] });
  s.scheduler.runNow(t.id);
  await Bun.sleep(50);
  await s.chat.idle(s.room.id);
  expect(s.final("memory_save")).toMatchObject({ status: "denied", reason: "unattended" });
  expect(s.calls().some((c) => c.status === "pending")).toBe(false);
});

test("예산이 없으면 건너뛰고, 방이 응답 중이면 기다리다 놓치면 busy 로 건너뜀", async () => {
  let clock = Date.now();
  const s = setup(() => null, { budgets: { tasks: 1 }, now: () => clock });
  const a = task(s);
  const b = task(s, { title: "둘째" });
  dueNow(s, a.id, clock);
  await s.scheduler.tick(); // 요청 1회로 예산을 다 씀
  dueNow(s, b.id, clock);
  await s.scheduler.tick();
  expect(s.store.runs(b.id)[0]).toMatchObject({ status: "skipped", reason: "budget" });

  // 방이 응답 중: 다음 tick 에 다시, 10분이 지나면 busy 로 건너뜀
  let release = () => {};
  const s2 = setup(() => null, {
    now: () => clock,
    slow: () =>
      new Promise<void>((r) => {
        release = r;
      }),
  });
  const c = task(s2);
  s2.chat.send(s2.room.id, "긴 대화", "m");
  dueNow(s2, c.id, clock);
  await s2.scheduler.tick();
  expect(s2.store.runs(c.id)).toHaveLength(0);
  clock += 11 * 60_000;
  await s2.scheduler.tick();
  expect(s2.store.runs(c.id)[0]).toMatchObject({ status: "skipped", reason: "busy" });
  release();
  await s2.chat.idle(s2.room.id);
});

test("대화 중 task_create 는 늘 확인 카드 (일정 설명·다음 실행·허용 도구), 허용하면 만들어진다", async () => {
  const s = setup((req) =>
    outputs(req) === 0
      ? [
          fc("task_create", {
            title: "주간 보고",
            instruction: "이번 주 메모를 모아 보고",
            schedule: { kind: "weekly", time: "18:00", days: [5], day: null, hours: null, cron: null },
            allowed_tools: ["note_create"],
          }),
        ]
      : null,
  );
  s.agents.updateAgent(s.agent.id, AgentInput.parse({ ...s.agent, autoApproveWrites: true }));
  s.chat.send(s.room.id, "매주 금요일 저녁에 보고해 줘", "m");
  const start = Date.now();
  while (s.final("task_create")?.status !== "pending" && Date.now() - start < 5000) await Bun.sleep(5);
  const card = s.final("task_create");
  expect(card?.status).toBe("pending");
  expect(card?.preview).toContain("매주 금 18:00");
  expect(card?.preview).toContain("확인 없이 할 쓰기 도구: note_create");
  s.chat.decide(card?.id ?? "", true);
  await s.chat.idle(s.room.id);
  expect(s.store.list(s.room.id)).toMatchObject([
    { title: "주간 보고", createdBy: s.agent.id, allowedTools: ["note_create"] },
  ]);
});

const runDirect = async (s: ReturnType<typeof setup>, allowedTools: string[]) => {
  const p = s.chat.startTask({
    roomId: s.room.id,
    agentId: s.agent.id,
    title: "직접",
    prompt: "해",
    allowedTools,
    defaultModel: "m",
  });
  if (typeof p === "string") throw new Error(p);
  return p;
};

test("늘 확인하는 도구(명령 실행)는 허용 목록에 있어도 거절 (저장 검사를 거치지 않아도)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proprix-task-ws-"));
  const s = setup(
    (req) =>
      outputs(req) === 0 ? [fc("shell_run", { command: "Write-Output hi", cwd: null, timeout_sec: 10 }, "sh")] : null,
    { tools: ["shell_run", "note_create"], workspace: true },
  );
  s.chat.updateRoom(s.room.id, { workspace: dir, shellEnabled: true });
  const o = await runDirect(s, ["shell_run"]);
  expect(s.final("shell_run")).toMatchObject({ status: "denied", reason: "unattended" });
  expect(o).toMatchObject({ status: "done", rejected: 1 });
  expect(s.calls().some((c) => c.status === "pending")).toBe(false);
});

test("파일을 읽은 뒤에는 폴더 안 쓰기만 (허용한 fs_write 는 실행, 허용한 메모 저장은 거절)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proprix-task-ws-"));
  writeFileSync(join(dir, "a.txt"), "hello\n");
  const s = setup(
    (req) => {
      const n = outputs(req);
      if (n === 0) return [fc("fs_read", { path: "a.txt", offset: null, limit: null }, "r")];
      if (n === 1) return [fc("fs_write", { path: "b.txt", content: "요약" }, "w")];
      if (n === 2) return [fc("note_create", { title: "t", body: "b" }, "n")];
      return null;
    },
    { tools: ["fs_read", "fs_write", "note_create"], workspace: true },
  );
  s.chat.updateRoom(s.room.id, { workspace: dir });
  const o = await runDirect(s, ["fs_write", "note_create"]);
  expect(s.final("fs_write")?.status).toBe("done");
  expect(existsSync(join(dir, "b.txt"))).toBe(true);
  expect(s.final("note_create")).toMatchObject({ status: "denied", reason: "unattended" });
  expect(o.rejected).toBe(1);
});

test("지운 MCP 서버의 도구는 모든 작업의 허용 목록에서 빠진다 (이름이 비슷한 다른 서버는 그대로)", () => {
  const s = setup(() => null);
  const t = task(s, { allowedTools: ["mcp__fx__echo", "mcp__fx2__echo", "note_create"] });
  s.store.revokeToolPrefix("mcp__FX__");
  expect(s.store.get(t.id)?.allowedTools).toEqual(["mcp__fx2__echo", "note_create"]);
});
