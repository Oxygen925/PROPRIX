// 임시 작업자 (P9a): 동시 실행·결과 묶음, 줄 수 없는 도구 제외, 대화 이력 없음, 승인 상속(항상 허용·이번 답의 허용·오염), 중지
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Agent, AgentInput, type ServerEvent, type ToolCall } from "@proprix/shared";
import type { AiRequest } from "@proprix/siwc";
import { AgentStore, DEFAULT_PERSONA_ID } from "../agents/store";
import type { StreamOptions, StreamResult } from "../auth/account";
import { SummaryService } from "../context/summary";
import { LlmGate } from "../llm/gate";
import { migrate } from "../storage/db";
import { ChatService } from "./chat";
import { makeChatTools } from "./test-helpers";

const fc = (name: string, args: object, id = name) => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: `call_${id}`,
  name,
  arguments: JSON.stringify(args),
  status: "completed",
});
const outputs = (req: AiRequest) => (req.items ?? []).filter((i) => i.type === "function_call_output");
const isWorker = (req: AiRequest) => req.instructions?.includes("# Worker task") ?? false;
const taskOf = (req: AiRequest) => (req.turns?.[0] && "text" in req.turns[0] ? req.turns[0].text : "");
const toolNames = (req?: AiRequest) => (req?.tools ?? []).map((t) => (t.type === "function" ? t.name : t.type));

function setup(
  script: (req: AiRequest) => Record<string, unknown>[] | null,
  delay = 0,
  opts: { tools?: string[]; workspace?: boolean } = {},
) {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const requests: AiRequest[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const llm = {
    async stream(req: AiRequest, opt: StreamOptions): Promise<StreamResult> {
      requests.push(structuredClone(req));
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      if (delay) await Bun.sleep(delay);
      inflight--;
      const items = script(req) ?? [];
      const text = isWorker(req) ? `결과:${taskOf(req).replace(/<\/?task>|\n/g, "")}` : "끝";
      if (!items.length) opt.onDelta(text);
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
          : [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
      };
    },
  };
  const events: ServerEvent[] = [];
  const emit = (e: ServerEvent) => events.push(e);
  const gate = new LlmGate(db, () => {});
  const agents = new AgentStore(db);
  const summaries = new SummaryService(db, llm, gate, emit, () => "a");
  const tools = makeChatTools(db, llm, gate, agents, emit, {
    snapshotsDir: opts.workspace ? mkdtempSync(join(tmpdir(), "proprix-wk-snap-")) : undefined,
  });
  const chat = new ChatService(db, llm, gate, agents, summaries, tools, emit);
  const agent = agents.createAgent(
    AgentInput.parse({
      personaId: DEFAULT_PERSONA_ID,
      name: "반장",
      tools: opts.tools ?? ["note_create", "memory_search", "run_workers", "delegate_to_agent", "reminder_create"],
    }),
  ) as Agent;
  const room = chat.createRoom("w", [agent.id]);
  if (typeof room === "string") throw new Error(room);
  const calls = () =>
    events.filter((e): e is Extract<ServerEvent, { type: "tool" }> => e.type === "tool").map((e) => e.call);
  // 같은 id 의 마지막 상태들
  const latest = (): ToolCall[] => [...new Map(calls().map((c) => [c.id, c])).values()];
  return { chat, room, agent, agents, requests, calls, latest, maxInflight: () => maxInflight };
}

async function until(pred: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await Bun.sleep(5);
  }
}

const workersCall = (workers: { title: string; task: string; tools: string[] }[], id = "rw") =>
  fc("run_workers", { workers }, id);

test("작업자 둘이 동시에 돌고 결과가 묶여 돌아온다. 줄 수 없는 도구는 빠지고, 작업자는 대화 이력을 못 본다", async () => {
  const s = setup((req) => {
    if (isWorker(req)) return null;
    return outputs(req).length === 0
      ? [
          workersCall([
            { title: "가", task: "사과 조사", tools: ["note_create", "delegate_to_agent", "run_workers", "없는도구"] },
            { title: "나", task: "배 조사", tools: [] },
          ]),
        ]
      : null;
  }, 30);
  s.chat.send(s.room.id, "과일 비교해 줘", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  const workers = s.requests.filter(isWorker);
  expect(workers).toHaveLength(2);
  expect(s.maxInflight()).toBeGreaterThanOrEqual(2);
  for (const w of workers) {
    expect(w.turns).toHaveLength(1); // 맡긴 일만
    expect(JSON.stringify(w.turns)).not.toContain("과일 비교해 줘");
  }
  const ga = workers.find((w) => taskOf(w).includes("사과"));
  expect(toolNames(ga)).toEqual(["note_create"]);
  expect(toolNames(workers.find((w) => taskOf(w).includes("배")))).toEqual([]);
  const rows = s.latest().filter((c) => c.name === "worker");
  expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
  const run = s.latest().find((c) => c.name === "run_workers");
  expect(rows.every((r) => r.parentId === run?.id)).toBe(true);
  const back = s.requests.at(-1)?.items?.find((i) => i.type === "function_call_output") as { output: string };
  const parsed = JSON.parse(back.output) as { workers: { title: string; result: string; ignored_tools?: string[] }[] };
  expect(parsed.workers.map((w) => w.title)).toEqual(["가", "나"]);
  expect(parsed.workers[0]?.result).toContain("사과 조사");
  expect(parsed.workers[0]?.ignored_tools).toEqual(["delegate_to_agent", "run_workers", "없는도구"]);
});

test("승인: 부모의 '항상 허용'은 그대로, 허용 이력이 없으면 확인 카드 (작업자 행 아래), 이번 답에서 부모가 받은 허용은 물려받음", async () => {
  // 1) 항상 허용 → 바로
  const a = setup((req) =>
    isWorker(req)
      ? outputs(req).length === 0
        ? [fc("note_create", { title: "t", body: "b" }, "wn")]
        : null
      : outputs(req).length === 0
        ? [workersCall([{ title: "메모", task: "메모 남겨", tools: ["note_create"] }])]
        : null,
  );
  a.agents.allowTool(a.agent.id, "note_create");
  a.chat.send(a.room.id, "해", "m");
  await until(() => !a.chat.room(a.room.id)?.running);
  expect(a.calls().some((c) => c.name === "note_create" && c.status === "pending")).toBe(false);
  expect(a.latest().find((c) => c.name === "note_create")?.status).toBe("done");

  // 2) 이력 없음 → 확인 카드, 부모는 작업자 행
  const b = setup((req) =>
    isWorker(req)
      ? outputs(req).length === 0
        ? [fc("note_create", { title: "t", body: "b" }, "wn")]
        : null
      : outputs(req).length === 0
        ? [workersCall([{ title: "메모", task: "메모 남겨", tools: ["note_create"] }])]
        : null,
  );
  b.chat.send(b.room.id, "해", "m");
  await until(() => b.latest().some((c) => c.name === "note_create" && c.status === "pending"));
  const card = b.latest().find((c) => c.name === "note_create");
  const row = b.latest().find((c) => c.name === "worker");
  expect(card?.parentId).toBe(row?.id);
  b.chat.decide(card?.id ?? "", true);
  await until(() => !b.chat.room(b.room.id)?.running);
  expect(b.latest().find((c) => c.name === "note_create")?.status).toBe("done");

  // 3) 부모가 이번 답에서 한 번 허용 → 작업자는 확인 없이
  const c = setup((req) => {
    if (isWorker(req)) return outputs(req).length === 0 ? [fc("note_create", { title: "w", body: "b" }, "wn")] : null;
    const n = outputs(req).length;
    if (n === 0) return [fc("note_create", { title: "부모", body: "b" }, "pn")];
    if (n === 1) return [workersCall([{ title: "메모", task: "메모 남겨", tools: ["note_create"] }])];
    return null;
  });
  c.chat.send(c.room.id, "해", "m");
  await until(() => c.latest().some((x) => x.name === "note_create" && x.status === "pending"));
  c.chat.decide(c.latest().find((x) => x.status === "pending")?.id ?? "", true);
  await until(() => !c.chat.room(c.room.id)?.running);
  const notes = c.latest().filter((x) => x.name === "note_create");
  expect(notes).toHaveLength(2);
  expect(notes.every((x) => x.status === "done")).toBe(true);
  expect(c.calls().filter((x) => x.name === "note_create" && x.status === "pending")).toHaveLength(1); // 부모 것만
});

test("웹 검색 결과가 들어간 뒤에는 물려받은 허용이 있어도 확인, 부모 중지는 작업자까지 멈춘다", async () => {
  const s = setup((req) =>
    isWorker(req)
      ? outputs(req).length === 0
        ? [fc("note_create", { title: "t", body: "b" }, "wn")]
        : null
      : outputs(req).length === 0
        ? [
            { type: "web_search_call", id: "ws1", status: "completed" },
            workersCall([{ title: "메모", task: "메모 남겨", tools: ["note_create"] }]),
          ]
        : null,
  );
  s.agents.allowTool(s.agent.id, "note_create");
  s.chat.send(s.room.id, "찾아서 메모해", "m");
  await until(() => s.latest().some((c) => c.name === "note_create" && c.status === "pending"));
  s.chat.cancel(s.room.id);
  await until(() => !s.chat.room(s.room.id)?.running);
  expect(s.latest().find((c) => c.name === "note_create")).toMatchObject({ status: "denied", reason: "cancelled" });
  expect(s.latest().filter((c) => c.status === "running" || c.status === "pending")).toEqual([]);
});

test("위임 받은 실행·작업자에게는 run_workers 가 보이지 않는다", async () => {
  const s = setup((req) =>
    isWorker(req) ? null : outputs(req).length === 0 ? [workersCall([{ title: "x", task: "y", tools: [] }])] : null,
  );
  s.chat.send(s.room.id, "해", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  expect(toolNames(s.requests[0])).toContain("run_workers");
  expect(toolNames(s.requests.find(isWorker))).not.toContain("run_workers");
});

test("명령 실행은 부모가 이번 답에서 허용했어도 작업자에게 다시 확인", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proprix-wk-ws-"));
  const sh = (id: string) => fc("shell_run", { command: "Write-Output hi", cwd: null, timeout_sec: 10 }, id);
  const s = setup(
    (req) => {
      if (isWorker(req)) return outputs(req).length === 0 ? [sh("w")] : null;
      const n = outputs(req).length;
      if (n === 0) return [sh("p")];
      if (n === 1) return [workersCall([{ title: "명령", task: "다시 실행", tools: ["shell_run"] }])];
      return null;
    },
    0,
    { tools: ["shell_run", "run_workers"], workspace: true },
  );
  s.chat.updateRoom(s.room.id, { workspace: dir, shellEnabled: true });
  s.chat.send(s.room.id, "실행해", "m");
  await until(() => s.latest().some((c) => c.name === "shell_run" && c.status === "pending"));
  s.chat.decide(s.latest().find((c) => c.status === "pending")?.id ?? "", true);
  // 작업자의 shell_run 도 확인 카드
  await until(
    () =>
      s.latest().filter((c) => c.name === "shell_run").length === 2 &&
      s.latest().some((c) => c.name === "shell_run" && c.status === "pending"),
    20_000,
  );
  const workerShell = s.latest().find((c) => c.name === "shell_run" && c.status === "pending");
  expect(s.latest().find((c) => c.id === workerShell?.parentId)?.name).toBe("worker");
  s.chat.decide(workerShell?.id ?? "", false);
  await until(() => !s.chat.room(s.room.id)?.running, 20_000);
}, 40_000);

test("예약 작업 안에서는 작업자도 무인 규칙: 허용 목록 밖 쓰기는 대기 없이 거절", async () => {
  const s = setup((req) =>
    isWorker(req)
      ? outputs(req).length === 0
        ? [fc("note_create", { title: "t", body: "b" }, "wn")]
        : null
      : outputs(req).length === 0
        ? [workersCall([{ title: "메모", task: "메모 남겨", tools: ["note_create"] }])]
        : null,
  );
  s.agents.allowTool(s.agent.id, "note_create"); // 부모의 항상 허용도 무인 규칙보다 앞서지 않는다
  const run = s.chat.startTask({
    roomId: s.room.id,
    agentId: s.agent.id,
    title: "예약",
    prompt: "작업자에게 맡겨",
    allowedTools: [],
    defaultModel: "m",
  });
  if (typeof run === "string") throw new Error(run);
  const o = await run;
  expect(s.latest().find((c) => c.name === "note_create")).toMatchObject({ status: "denied", reason: "unattended" });
  expect(s.calls().some((c) => c.status === "pending")).toBe(false);
  expect(o.rejected).toBe(1);
});

test("웹 검색: 부모가 쓸 수 있으면 작업자에게 web_search 로 줄 수 있고, 검색 뒤 쓰기는 항상 허용이어도 확인", async () => {
  const s = setup((req) => {
    if (isWorker(req))
      return outputs(req).length === 0 && taskOf(req).includes("검색")
        ? [
            { type: "web_search_call", id: "ws", status: "completed" },
            fc("note_create", { title: "t", body: "b" }, "wn"),
          ]
        : null;
    return outputs(req).length === 0
      ? [
          workersCall([
            { title: "검색", task: "검색해서 메모", tools: ["web_search", "note_create"] },
            { title: "그냥", task: "생각만", tools: ["note_create"] },
          ]),
        ]
      : null;
  });
  s.agents.updateAgent(s.agent.id, AgentInput.parse({ ...s.agent, webSearch: true }));
  s.agents.allowTool(s.agent.id, "note_create");
  s.chat.send(s.room.id, "조사해", "m");
  await until(() => s.latest().some((c) => c.name === "note_create" && c.status === "pending"));
  const searchWorker = s.requests.find((r) => isWorker(r) && taskOf(r).includes("검색"));
  const plainWorker = s.requests.find((r) => isWorker(r) && taskOf(r).includes("생각만"));
  expect(toolNames(searchWorker)).toEqual(expect.arrayContaining(["web_search", "note_create"]));
  expect(toolNames(plainWorker)).toEqual(["note_create"]);
  s.chat.decide(s.latest().find((c) => c.status === "pending")?.id ?? "", false);
  await until(() => !s.chat.room(s.room.id)?.running);
});
