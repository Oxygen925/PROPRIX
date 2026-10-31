// 도구 호출 루프 (가짜 LLM 시나리오): 자동 실행·승인·거부·시간 초과·중지·허용 안 됨·잘못된 인자·단계 상한·웹 검색 안전장치
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Agent, AgentInput, type ServerEvent, SHARED_SCOPE, type ToolCall } from "@proprix/shared";
import type { AiRequest } from "@proprix/siwc";
import { AgentStore, DEFAULT_PERSONA_ID } from "../agents/store";
import type { StreamOptions, StreamResult } from "../auth/account";
import { SummaryService } from "../context/summary";
import { LlmGate } from "../llm/gate";
import { migrate } from "../storage/db";
import { ChatService, MAX_TOOL_STEPS } from "./chat";
import { makeChatTools } from "./test-helpers";

type Step = { text?: string; items?: Record<string, unknown>[] };
type Script = (req: AiRequest, step: number) => Step;

const fc = (name: string, args: object, id = name) => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: `call_${id}`,
  name,
  arguments: JSON.stringify(args),
  status: "completed",
});

function setup(script: Script, agentPatch: Partial<AgentInput> = {}, approvalTimeoutMs = 5000) {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  const requests: AiRequest[] = [];
  const llm = {
    async stream(req: AiRequest, opt: StreamOptions): Promise<StreamResult> {
      const step = requests.push(structuredClone(req)) - 1;
      const s = script(req, step);
      if (s.text) opt.onDelta(s.text);
      const items = [...(s.items ?? [])];
      if (s.text)
        items.unshift({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: s.text, annotations: [] }],
        });
      return {
        outcome: "completed",
        code: "",
        param: "",
        recovery: "none",
        http: 200,
        attempts: 1,
        chars: 0,
        requestId: "",
        items,
      };
    },
  };
  const events: ServerEvent[] = [];
  const emit = (e: ServerEvent) => events.push(e);
  const gate = new LlmGate(db, () => {});
  const agents = new AgentStore(db);
  const summaries = new SummaryService(db, llm, gate, emit, () => "a");
  const tools = makeChatTools(db, llm, gate, agents, emit, { approvalTimeoutMs });
  const { notes } = tools;
  const chat = new ChatService(db, llm, gate, agents, summaries, tools, emit);
  const agent = agents.createAgent(
    AgentInput.parse({ personaId: DEFAULT_PERSONA_ID, name: "도구봇", ...agentPatch }),
  ) as Agent;
  const room = chat.createRoom("t", [agent.id]);
  if (typeof room === "string") throw new Error(room);
  const calls = () =>
    events.filter((e): e is Extract<ServerEvent, { type: "tool" }> => e.type === "tool").map((e) => e.call);
  const lastCall = (): ToolCall | undefined => calls().at(-1);
  return { chat, notes, memory: tools.memory, room, requests, events, calls, lastCall, agent };
}

async function until(pred: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await Bun.sleep(2);
  }
}

const done = (chat: ChatService, roomId: string) => () => !chat.room(roomId)?.running;

test("읽기 도구는 바로 실행하고, 출력 항목 + 결과를 붙여 다시 요청한다", async () => {
  const s = setup((_req, step) => (step === 0 ? { items: [fc("current_time", {})] } : { text: "지금은 오후입니다." }));
  s.chat.send(s.room.id, "몇 시야?", "m");
  await until(done(s.chat, s.room.id));

  const tools = s.requests[0]?.tools ?? [];
  expect(tools.find((t) => t.type === "function" && t.name === "current_time")).toMatchObject({ strict: true });
  expect(s.lastCall()).toMatchObject({ name: "current_time", kind: "read", status: "done" });
  expect(s.calls().map((c) => c.status)).toEqual(["running", "done"]); // 확인 대기 없음
  const second = s.requests[1]?.items ?? [];
  expect(second[0]).toMatchObject({ type: "function_call", call_id: "call_current_time" });
  expect(second[1]).toMatchObject({ type: "function_call_output", call_id: "call_current_time" });
  expect(JSON.parse(String(second[1]?.output))).toHaveProperty("timezone");
  expect(s.chat.messages(s.room.id).at(-1)).toMatchObject({ status: "complete", content: "지금은 오후입니다." });
});

test("쓰기 도구는 확인을 기다린다: 허용하면 실행", async () => {
  const s = setup((_r, step) =>
    step === 0 ? { items: [fc("note_create", { title: "장보기", body: "우유" })] } : { text: "저장했어요." },
  );
  s.chat.send(s.room.id, "메모해줘", "m");
  await until(() => s.lastCall()?.status === "pending");
  expect(s.notes.list()).toHaveLength(0);
  const id = s.lastCall()?.id ?? "";
  expect(s.chat.pendingCalls().map((c) => c.id)).toEqual([id]); // 홈 '확인 필요'
  expect(s.chat.decide(id, true)).toBe(true);
  expect(s.chat.decide(id, true)).toBe(false); // 한 번만
  await until(() => s.chat.pendingCalls().length === 0);
  await until(done(s.chat, s.room.id));
  expect(s.notes.list().map((n) => n.title)).toEqual(["장보기"]);
  expect(s.lastCall()).toMatchObject({ status: "done" });
});

test("거부하면 실행하지 않고 거부 사실을 모델에 알린다", async () => {
  const s = setup((_r, step) =>
    step === 0 ? { items: [fc("note_create", { title: "x", body: "" })] } : { text: "알겠어요." },
  );
  s.chat.send(s.room.id, "메모해줘", "m");
  await until(() => s.lastCall()?.status === "pending");
  s.chat.decide(s.lastCall()?.id ?? "", false);
  await until(done(s.chat, s.room.id));
  expect(s.notes.list()).toHaveLength(0);
  expect(s.lastCall()).toMatchObject({ status: "denied", reason: "deny" });
  expect(String(s.requests[1]?.items?.[1]?.output)).toContain("denied");
});

test("확인 시간 초과·중지", async () => {
  const t = setup(
    (_r, step) => (step === 0 ? { items: [fc("note_delete", { id: "x" })] } : { text: "못 했어요." }),
    {},
    30,
  );
  t.chat.send(t.room.id, "지워줘", "m");
  await until(done(t.chat, t.room.id));
  expect(t.lastCall()).toMatchObject({ status: "denied", reason: "timeout" });

  const c = setup((_r, step) =>
    step === 0 ? { items: [fc("note_create", { title: "x", body: "" })] } : { text: "x" },
  );
  c.chat.send(c.room.id, "메모", "m");
  await until(() => c.lastCall()?.status === "pending");
  c.chat.cancel(c.room.id);
  await until(done(c.chat, c.room.id));
  expect(c.lastCall()).toMatchObject({ status: "denied", reason: "cancelled" });
  expect(c.chat.messages(c.room.id).at(-1)).toMatchObject({ status: "failed", errorCode: "cancelled" });
  expect(c.requests).toHaveLength(1); // 중지 뒤에는 다시 요청하지 않는다
});

test("'항상 허용'이면 바로 실행하지만, 웹 검색이 들어간 턴에서는 확인을 받는다", async () => {
  const auto = setup(
    (_r, step) => (step === 0 ? { items: [fc("note_create", { title: "자동", body: "" })] } : { text: "ok" }),
    { autoApproveWrites: true },
  );
  auto.chat.send(auto.room.id, "메모", "m");
  await until(done(auto.chat, auto.room.id));
  expect(auto.calls().map((c) => c.status)).toEqual(["running", "done"]);

  const web = setup(
    (_r, step) =>
      step === 0
        ? {
            items: [
              { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "q" } },
              fc("note_create", { title: "검색 결과", body: "" }),
            ],
          }
        : { text: "ok" },
    { autoApproveWrites: true, webSearch: true },
  );
  web.chat.send(web.room.id, "검색해서 메모", "m");
  await until(() => web.lastCall()?.status === "pending");
  expect(web.requests[0]?.tools?.some((t) => t.type === "web_search")).toBe(true);
  web.chat.decide(web.lastCall()?.id ?? "", true);
  await until(done(web.chat, web.room.id));
});

test("바깥 데이터가 들어온 턴의 다음 한 턴은 확인받고, 그다음 턴은 원래대로 돌아간다", async () => {
  const s = setup(
    (req, step) => {
      if (req.items?.some((i) => i.type === "function_call_output")) return { text: "ok" };
      if (step === 0)
        return {
          items: [{ type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "q" } }],
          text: "검색했습니다",
        };
      return { items: [fc("note_create", { title: "메모", body: "" })] };
    },
    { autoApproveWrites: true, webSearch: true },
  );
  s.chat.send(s.room.id, "검색", "m");
  await until(done(s.chat, s.room.id));

  s.chat.send(s.room.id, "메모", "m");
  await until(() => s.lastCall()?.status === "pending");
  s.chat.decide(s.lastCall()?.id ?? "", true);
  await until(done(s.chat, s.room.id));

  const before = s.calls().length;
  s.chat.send(s.room.id, "또 메모", "m");
  await until(done(s.chat, s.room.id));
  const third = s.calls().slice(before);
  expect(third.length).toBeGreaterThan(0);
  expect(third.some((c) => c.status === "pending")).toBe(false);
});

test("승인 카드의 '항상 허용'은 이 에이전트의 이 도구만, 같은 턴부터 적용하고 해제할 수 있다", async () => {
  const s = setup((_r, step) =>
    step === 0
      ? { items: [fc("note_create", { title: "하나", body: "" }, "a")] }
      : step === 1
        ? { items: [fc("note_create", { title: "둘", body: "" }, "b")] }
        : step === 2
          ? { items: [fc("note_delete", { id: "x" }, "c")] }
          : { text: "ok" },
  );
  s.chat.send(s.room.id, "메모 두 개", "m");
  await until(() => s.lastCall()?.status === "pending");
  expect(s.chat.decide(s.lastCall()?.id ?? "", true, true)).toBe(true);
  // 같은 턴의 두 번째 note_create 는 확인 없이, 다른 쓰기 도구(note_delete)는 여전히 확인
  await until(() => s.lastCall()?.name === "note_delete" && s.lastCall()?.status === "pending");
  expect(s.calls().filter((c) => c.name === "note_create" && c.status === "pending")).toHaveLength(1);
  expect(
    s.notes
      .list()
      .map((n) => n.title)
      .sort(),
  ).toEqual(["둘", "하나"]);
  s.chat.decide(s.lastCall()?.id ?? "", false);
  await until(done(s.chat, s.room.id));
  expect(s.events.some((e) => e.type === "agents")).toBe(true);

  // 규칙 해제
  expect(s.chat.revokeTool(s.agent.id, "note_create")?.autoApproveTools).toEqual([]);
  expect(s.chat.revokeTool(crypto.randomUUID(), "note_create")).toBeNull();
});

test("'항상 허용'한 도구도 웹 검색이 들어간 턴에서는 확인을 받는다", async () => {
  // 턴마다: 도구 결과가 아직 없으면 검색 + 쓰기, 있으면 답
  const s = setup(
    (req) =>
      req.items?.some((i) => i.type === "function_call_output")
        ? { text: "ok" }
        : {
            items: [
              { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "q" } },
              fc("note_create", { title: "검색 결과", body: "" }),
            ],
          },
    { webSearch: true },
  );
  // 거부해도 규칙은 저장하지 않는다
  s.chat.send(s.room.id, "메모", "m");
  await until(() => s.lastCall()?.status === "pending");
  s.chat.decide(s.lastCall()?.id ?? "", false, true);
  await until(done(s.chat, s.room.id));
  expect(s.chat.revokeTool(s.agent.id, "x")?.autoApproveTools).toEqual([]);

  s.chat.send(s.room.id, "다시", "m");
  await until(() => s.lastCall()?.status === "pending");
  s.chat.decide(s.lastCall()?.id ?? "", true, true);
  await until(done(s.chat, s.room.id));
  s.chat.send(s.room.id, "또", "m");
  await until(() => s.lastCall()?.status === "pending"); // 규칙이 있어도 검색 턴이라 확인
  s.chat.decide(s.lastCall()?.id ?? "", true);
  await until(done(s.chat, s.room.id));
});

test("허용되지 않은 도구·잘못된 인자는 실패로 모델에 알린다", async () => {
  const s = setup(
    (_r, step) =>
      step === 0
        ? { items: [fc("note_delete", { id: "x" }, "a"), fc("note_search", { query: 3 }, "b")] }
        : { text: "ok" },
    { tools: ["note_search"] },
  );
  s.chat.send(s.room.id, "?", "m");
  await until(done(s.chat, s.room.id));
  const byName = Object.fromEntries(
    s
      .calls()
      .filter((c) => c.status !== "running")
      .map((c) => [c.name, c]),
  );
  expect(byName.note_delete).toMatchObject({ status: "failed", reason: "not_allowed" });
  expect(byName.note_search).toMatchObject({ status: "failed" });
  expect(byName.note_search?.output).toContain("invalid arguments");
  // 허용된 도구만 선언한다
  expect(s.requests[0]?.tools?.map((t) => (t.type === "function" ? t.name : t.type))).toEqual(["note_search"]);
});

test(`단계 상한(${MAX_TOOL_STEPS})을 넘으면 tool_loop_limit 로 끝난다`, async () => {
  const s = setup((_r, step) => ({ items: [fc("current_time", {}, `s${step}`)] }));
  s.chat.send(s.room.id, "무한", "m");
  await until(done(s.chat, s.room.id));
  expect(s.requests).toHaveLength(MAX_TOOL_STEPS);
  expect(s.chat.messages(s.room.id).at(-1)).toMatchObject({ errorCode: "tool_loop_limit" });
});

test("단계 사이 텍스트는 문단으로 잇고, 웹 검색 출처를 저장한다", async () => {
  const cite = {
    type: "message",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: "b",
        annotations: [
          { type: "url_citation", url: "https://bun.sh/", title: "Bun" },
          { type: "url_citation", url: "javascript:alert(1)", title: "x" },
        ],
      },
    ],
  };
  const s = setup((_r, step) =>
    step === 0 ? { text: "확인해 볼게요.", items: [fc("current_time", {})] } : { text: "결과입니다.", items: [cite] },
  );
  s.chat.send(s.room.id, "?", "m");
  await until(done(s.chat, s.room.id));
  const last = s.chat.messages(s.room.id).at(-1);
  expect(last?.content).toBe("확인해 볼게요.\n\n결과입니다.");
  expect(last?.sources).toEqual([{ url: "https://bun.sh/", title: "Bun" }]); // http(s) 만
  // 텍스트가 섞인 응답도 message 항목을 그대로 다시 보낸다
  expect(s.requests[1]?.items?.map((i) => i.type)).toEqual(["message", "function_call", "function_call_output"]);
});

test("메모리: 관련 기억을 instructions 에 넣고 참고한 기억을 메시지에 남긴다", async () => {
  const s = setup(() => ({ text: "고양이 이름은 나비죠." }));
  const m = s.memory.store.create({
    scope: SHARED_SCOPE,
    kind: "fact",
    content: "고양이 이름은 나비",
    contentEn: "The user's cat is named 나비 (Nabi)",
    importance: 3,
    validUntil: null,
  });
  s.chat.send(s.room.id, "우리 고양이 이름 기억나?", "m");
  await until(done(s.chat, s.room.id));
  const instructions = s.requests[0]?.instructions ?? "";
  expect(instructions).toContain("<memories>");
  expect(instructions).toContain("(fact, ");
  expect(instructions).toContain("The user's cat is named 나비 (Nabi)"); // 영어본을 주입
  expect(s.chat.messages(s.room.id).at(-1)?.memoryIds).toEqual([m.id]);
});

test("메모리 도구: 저장은 확인 없이(웹 검색 턴은 확인), 격리 에이전트는 공용 기억을 지울 수 없다", async () => {
  const saveCall = fc("memory_save", {
    kind: "preference",
    scope: "shared",
    content: "땅콩 알레르기가 있다",
    content_en: "Allergic to peanuts",
    importance: 5,
  });
  const save = setup((_r, step) => (step === 0 ? { items: [saveCall] } : { text: "기억할게요." }));
  save.chat.send(save.room.id, "나 땅콩 알레르기 있는 거 기억해줘", "m");
  await until(done(save.chat, save.room.id));
  expect(save.lastCall()).toMatchObject({ name: "memory_save", status: "done" });
  expect(save.memory.store.list().map((m) => [m.content, m.scope])).toEqual([["땅콩 알레르기가 있다", SHARED_SCOPE]]);
  // 출처: 이 방과 저장한 답 (P10e)
  expect(save.memory.store.list()[0]).toMatchObject({
    sourceRoomId: save.room.id,
    sourceMessageId: save.lastCall()?.messageId,
  });

  // 웹 검색 결과가 들어간 턴: 확인 받음
  const web = setup(
    (_r, step) =>
      step === 0
        ? { items: [{ type: "web_search_call", id: "ws", status: "completed" }, saveCall] }
        : { text: "기억할게요." },
    { webSearch: true },
  );
  web.chat.send(web.room.id, "찾아보고 기억해", "m");
  await until(() => web.lastCall()?.status === "pending");
  expect(web.memory.store.list()).toHaveLength(0);
  web.chat.decide(web.lastCall()?.id ?? "", false);
  await until(done(web.chat, web.room.id));
  expect(web.memory.store.list()).toHaveLength(0);

  let sharedId = "";
  const iso = setup(
    (_r, step) => (step === 0 ? { items: [fc("memory_forget", { id: sharedId })] } : { text: "못 지웠어요." }),
    { memoryIsolated: true, autoApproveWrites: true },
  );
  sharedId = iso.memory.store.create({
    scope: SHARED_SCOPE,
    kind: "fact",
    content: "공용 기억",
    contentEn: "",
    importance: 3,
    validUntil: null,
  }).id;
  iso.chat.send(iso.room.id, "그거 잊어줘", "m");
  await until(done(iso.chat, iso.room.id));
  expect(iso.lastCall()?.output).toContain("read-only");
  expect(iso.memory.store.get(sharedId)).not.toBeNull();
});

test("중지하면 자동 허용 쓰기라도 남은 호출을 실행하지 않는다", async () => {
  const s = setup(
    (_r, step) =>
      step === 0
        ? {
            items: [
              fc("note_create", { title: "첫째", body: "" }, "a"),
              fc("note_create", { title: "둘째", body: "" }, "b"),
            ],
          }
        : { text: "x" },
    { autoApproveWrites: true },
  );
  const create = s.notes.create.bind(s.notes);
  s.notes.create = (...args: Parameters<typeof create>) => {
    const note = create(...args);
    s.chat.cancel(s.room.id); // 첫 호출을 실행하는 동안 중지
    return note;
  };
  s.chat.send(s.room.id, "메모 둘", "m");
  await until(done(s.chat, s.room.id));
  expect(s.notes.list().map((n) => n.title)).toEqual(["첫째"]);
  expect(s.requests).toHaveLength(1);
  expect(s.chat.messages(s.room.id).at(-1)).toMatchObject({ status: "failed", errorCode: "cancelled" });
});
