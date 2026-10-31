// MCP 도구가 대화 흐름에서: 켠 에이전트만 보임, ask 는 '모든 쓰기 허용'이어도 확인, 도구별 '항상 허용'은 적용,
// readonly-auto 의 readOnlyHint 도구는 바로 실행, 결과는 턴을 오염시킨다
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { type Agent, AgentInput, type ServerEvent, type ToolCall } from "@proprix/shared";
import type { AiRequest } from "@proprix/siwc";
import { AgentStore, DEFAULT_PERSONA_ID } from "../agents/store";
import type { StreamOptions, StreamResult } from "../auth/account";
import { SummaryService } from "../context/summary";
import { LlmGate } from "../llm/gate";
import { DEFAULT_MCP_OPTIONS, McpManager } from "../mcp/manager";
import { McpStore, plainCodec } from "../mcp/store";
import { migrate } from "../storage/db";
import { ChatService } from "./chat";
import { makeChatTools } from "./test-helpers";

const FIXTURE = join(import.meta.dir, "..", "mcp", "fixtures", "sdk-server.ts");
const managers: McpManager[] = [];
afterAll(async () => {
  for (const m of managers) await m.closeAll();
});

const fc = (name: string, args: object, id = name) => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: `call_${id}`,
  name,
  arguments: JSON.stringify(args),
  status: "completed",
});
const outputs = (req: AiRequest) => (req.items ?? []).filter((i) => i.type === "function_call_output");

async function setup(
  script: (req: AiRequest) => Record<string, unknown>[] | null,
  patch: Partial<AgentInput> = {},
  trust: "ask" | "readonly-auto" = "ask",
) {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const requests: AiRequest[] = [];
  const llm = {
    async stream(req: AiRequest, opt: StreamOptions): Promise<StreamResult> {
      requests.push(structuredClone(req));
      const items = script(req) ?? [];
      if (!items.length) opt.onDelta("끝");
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
          : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "끝", annotations: [] }] }],
      };
    },
  };
  const events: ServerEvent[] = [];
  const emit = (e: ServerEvent) => events.push(e);
  const gate = new LlmGate(db, () => {});
  const agents = new AgentStore(db);
  const store = new McpStore(db, plainCodec);
  const mcp = new McpManager(store, () => {}, { ...DEFAULT_MCP_OPTIONS, probeTimeoutMs: 2000 });
  managers.push(mcp);
  const server = store.create({ name: "fx", transport: "stdio", command: process.execPath, args: [FIXTURE], trust });
  if ("error" in server) throw new Error(server.message);
  await mcp.refresh(server.id);
  for (const n of ["echo", "env"]) store.setToolEnabled(server.id, n, true);
  const summaries = new SummaryService(db, llm, gate, emit, () => "a");
  const tools = makeChatTools(db, llm, gate, agents, emit, { mcp });
  const chat = new ChatService(db, llm, gate, agents, summaries, tools, emit);
  chat.mcpServersOf = (a) => a.mcpServers;
  const agent = agents.createAgent(
    AgentInput.parse({ personaId: DEFAULT_PERSONA_ID, name: "봇", tools: ["note_create"], ...patch }),
  ) as Agent;
  const room = chat.createRoom("m", [agent.id]);
  if (typeof room === "string") throw new Error(room);
  const calls = () =>
    events.filter((e): e is Extract<ServerEvent, { type: "tool" }> => e.type === "tool").map((e) => e.call);
  const lastCall = (): ToolCall | undefined => calls().at(-1);
  return { chat, room, requests, calls, lastCall, agent, agents, server, mcp };
}

async function until(pred: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await Bun.sleep(5);
  }
}
const toolNames = (req?: AiRequest) => (req?.tools ?? []).map((t) => (t.type === "function" ? t.name : t.type));

test("서버를 켜지 않은 에이전트에게는 MCP 도구가 없고, 켠 에이전트는 strict:false 로 받는다", async () => {
  const s = await setup(() => null);
  s.chat.send(s.room.id, "안녕", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  expect(toolNames(s.requests[0]).some((n) => n.startsWith("mcp__"))).toBe(false);

  s.agents.updateAgent(s.agent.id, AgentInput.parse({ ...s.agent, mcpServers: [s.server.id] }));
  s.chat.send(s.room.id, "다시", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  const req = s.requests.at(-1);
  expect(toolNames(req)).toEqual(expect.arrayContaining(["mcp__fx__echo", "mcp__fx__env"]));
  expect(req?.tools?.find((t) => t.type === "function" && t.name === "mcp__fx__echo")).toMatchObject({ strict: false });
  expect(req?.instructions).toContain("# MCP tools");
}, 60_000);

test("ask: '모든 쓰기 확인 없이'여도 확인 카드, 도구별 '항상 허용'은 다음부터 바로, 결과는 턴을 오염 (메모 쓰기 확인)", async () => {
  const s = await setup(
    (req) => {
      const n = outputs(req).length;
      if (JSON.stringify(req.turns).includes("쉬어") && !JSON.stringify(req.turns).includes("또")) return null;
      if (n === 0) return [fc("mcp__fx__echo", { text: "hi" }, `a${req.instructions?.length ?? 0}`)];
      if (n === 1) return [fc("note_create", { title: "t", body: "b" }, "note")];
      return null;
    },
    { autoApproveWrites: true },
  );
  s.agents.updateAgent(
    s.agent.id,
    AgentInput.parse({ ...s.agent, mcpServers: [s.server.id], autoApproveWrites: true }),
  );
  s.chat.send(s.room.id, "불러줘", "m");
  await until(() => s.lastCall()?.status === "pending");
  expect(s.lastCall()?.name).toBe("mcp__fx__echo");
  s.chat.decide(s.lastCall()?.id ?? "", true, true); // 항상 허용
  expect(s.agents.agent(s.agent.id)?.autoApproveTools).toContain("mcp__fx__echo");
  // MCP 결과가 들어간 턴: '모든 쓰기 허용'인데도 메모 쓰기를 확인받는다
  await until(() => s.lastCall()?.name === "note_create" && s.lastCall()?.status === "pending");
  expect(s.calls().findLast((c) => c.name === "mcp__fx__echo")?.output).toContain("echo:hi");
  s.chat.decide(s.lastCall()?.id ?? "", false);
  await until(() => !s.chat.room(s.room.id)?.running);

  // 다음 한 턴은 직전 턴의 오염을 이어받아 규칙이 있어도 확인받고, 도구를 쓰지 않은 턴이 지나면 규칙대로
  s.chat.send(s.room.id, "한 번 더", "m");
  await until(() => s.lastCall()?.name === "mcp__fx__echo" && s.lastCall()?.status === "pending");
  s.chat.cancel(s.room.id);
  await until(() => !s.chat.room(s.room.id)?.running);
  s.chat.send(s.room.id, "쉬어", "m");
  await until(() => !s.chat.room(s.room.id)?.running);

  // 규칙이 있으니 확인 없이 실행
  const before = s.calls().length;
  s.chat.send(s.room.id, "또", "m");
  await until(() =>
    s
      .calls()
      .slice(before)
      .some((c) => c.name === "mcp__fx__echo" && c.status === "done"),
  );
  expect(
    s
      .calls()
      .slice(before)
      .some((c) => c.name === "mcp__fx__echo" && c.status === "pending"),
  ).toBe(false);
  s.chat.cancel(s.room.id);
  await until(() => !s.chat.room(s.room.id)?.running);
}, 60_000);

test("readonly-auto: readOnlyHint 도구는 바로, 아닌 도구는 확인", async () => {
  const s = await setup(
    (req) => {
      const n = outputs(req).length;
      if (n === 0) return [fc("mcp__fx__echo", { text: "r" }, "r")];
      if (n === 1) return [fc("mcp__fx__env", {}, "e")];
      return null;
    },
    {},
    "readonly-auto",
  );
  s.agents.updateAgent(s.agent.id, AgentInput.parse({ ...s.agent, mcpServers: [s.server.id] }));
  s.chat.send(s.room.id, "읽어", "m");
  await until(() => s.lastCall()?.name === "mcp__fx__env" && s.lastCall()?.status === "pending");
  expect(s.calls().some((c) => c.name === "mcp__fx__echo" && c.status === "pending")).toBe(false);
  expect(s.calls().findLast((c) => c.name === "mcp__fx__echo")?.status).toBe("done");
  s.chat.decide(s.lastCall()?.id ?? "", false);
  await until(() => !s.chat.room(s.room.id)?.running);
}, 60_000);

test("서버를 지우면 그 서버 도구의 '항상 허용' 규칙도 지워져, 같은 이름으로 다시 만든 서버는 다시 확인받는다", async () => {
  const s = await setup((req) => (outputs(req).length === 0 ? [fc("mcp__fx__echo", { text: "x" }, "again")] : null));
  s.agents.allowTool(s.agent.id, "mcp__fx__echo");
  s.agents.allowTool(s.agent.id, "mcp__fx2__echo"); // 이름이 비슷한 다른 서버의 규칙은 남는다
  s.agents.allowTool(s.agent.id, "note_create");
  // routes 의 DELETE 와 같은 순서
  const row = s.mcp.store.get(s.server.id);
  await s.mcp.disconnect(s.server.id);
  s.mcp.store.remove(s.server.id);
  s.agents.removeMcpServer(s.server.id);
  s.agents.revokeToolPrefix(`mcp__${row?.name}__`);
  expect(s.agents.agent(s.agent.id)?.autoApproveTools).toEqual(["mcp__fx2__echo", "note_create"]);

  const again = s.mcp.store.create({ name: "fx", transport: "stdio", command: process.execPath, args: [FIXTURE] });
  if ("error" in again) throw new Error(again.message);
  await s.mcp.refresh(again.id);
  s.mcp.store.setToolEnabled(again.id, "echo", true);
  s.agents.updateAgent(s.agent.id, AgentInput.parse({ ...s.agents.agent(s.agent.id), mcpServers: [again.id] }));
  s.chat.send(s.room.id, "불러", "m");
  await until(() => s.lastCall()?.status === "pending");
  expect(s.lastCall()?.name).toBe("mcp__fx__echo");
  s.chat.decide(s.lastCall()?.id ?? "", false);
  await until(() => !s.chat.room(s.room.id)?.running);
}, 60_000);
