// ChatService + SummaryService + AgentStore 통합 (가짜 LLM): 페르소나·역할 조립, 에이전트 모델 우선, 롤링 요약
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { AgentInput, type Message, type ServerEvent } from "@proprix/shared";
import type { ChatTurn } from "@proprix/siwc";
import { AgentStore, DEFAULT_AGENT_ID, DEFAULT_PERSONA_ID } from "../agents/store";
import type { StreamOptions, StreamResult } from "../auth/account";
import { SummaryService } from "../context/summary";
import { LlmGate } from "../llm/gate";
import { migrate } from "../storage/db";
import { ChatService } from "./chat";
import { makeChatTools } from "./test-helpers";

interface Call {
  model: string;
  instructions: string;
  turns: ChatTurn[];
}

const ok = (chars: number): StreamResult => ({
  outcome: "completed",
  code: "",
  param: "",
  recovery: "none",
  http: 200,
  attempts: 1,
  chars,
  requestId: "",
  items: [],
});

function setup(summary = { recentMessages: 2, triggerChars: 30, hardCapMessages: 60 }) {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  const calls: Call[] = [];
  let summaryFails = false;
  let onTitle = () => {};
  const llm = {
    async stream(req: Call, opt: StreamOptions): Promise<StreamResult> {
      calls.push(req);
      if (req.turns.at(-1)?.text.includes("[search]")) opt.onSearch?.();
      if (req.instructions.startsWith("Write a short title")) {
        onTitle();
        opt.onDelta('"이어폰 비교"');
        return ok(7);
      }
      const isSummary = req.instructions.startsWith("You maintain a running summary");
      if (isSummary && summaryFails) return { ...ok(0), outcome: "failed", code: "x" };
      const text = isSummary ? `SUMMARY#${calls.length}` : `reply to ${req.turns.at(-1)?.text}`;
      opt.onDelta(text);
      return ok(text.length);
    },
  };
  const events: ServerEvent[] = [];
  const emit = (e: ServerEvent) => events.push(e);
  const gate = new LlmGate(db, () => {});
  const agents = new AgentStore(db);
  const summaries = new SummaryService(db, llm, gate, emit, (id) => agents.agent(id)?.name ?? "?", summary);
  const tools = makeChatTools(db, llm, gate, agents, emit);
  const chat = new ChatService(db, llm, gate, agents, summaries, tools, emit);
  return {
    db,
    calls,
    events,
    agents,
    summaries,
    chat,
    failSummary: (v: boolean) => {
      summaryFails = v;
    },
    whenTitling: (fn: () => void) => {
      onTitle = fn;
    },
  };
}

async function say(chat: ChatService, roomId: string, text: string, model = "global") {
  const r = chat.send(roomId, text, model);
  if (typeof r === "string") throw new Error(r);
  await chat.idle(roomId); // 응답 연쇄·저장이 끝날 때까지
  const replies = chat.messages(roomId).filter((m) => m.role === "assistant" && m.createdAt > r.user.createdAt);
  return { ...r, assistant: replies[0] as Message, replies };
}

test("방의 에이전트 페르소나·역할로 instructions 를 만들고, 에이전트 모델이 우선한다", async () => {
  const { agents, chat, calls } = setup();
  const persona = agents.createPersona({
    name: "고양이",
    emoji: "🐱",
    color: "#ffaa00",
    description: "",
    body: "- 말투: 끝에 냥",
    petCharacterId: "",
    avatarImage: "",
  });
  const agent = agents.createAgent(
    AgentInput.parse({
      personaId: persona.id,
      name: "일정 비서",
      role: "일정을 관리한다",
      model: "agent-model",
    }),
  );
  if (!agent) throw new Error("agent");
  const room = chat.createRoom("t", [agent.id]);
  if (typeof room === "string") throw new Error(room);

  const r = await say(chat, room.id, "안녕");
  expect(r.assistant.agentId).toBe(agent.id);
  expect(calls[0]?.model).toBe("agent-model");
  expect(calls[0]?.instructions).toContain('You are "일정 비서"');
  expect(calls[0]?.instructions).toContain("일정을 관리한다");
  expect(calls[0]?.instructions).toContain("- 말투: 끝에 냥");

  // 기본 에이전트는 모델이 비어 전역 모델을 쓴다
  const def = chat.createRoom("d");
  if (typeof def === "string") throw new Error(def);
  expect(def.agentIds).toEqual([DEFAULT_AGENT_ID]);
  await say(chat, def.id, "hi", "global-model");
  expect(calls.at(-1)?.model).toBe("global-model");
});

test("사용 중인 에이전트·페르소나와 기본 항목은 삭제할 수 없다", () => {
  const { agents, chat } = setup();
  const p = agents.createPersona({
    name: "p",
    emoji: "🙂",
    color: "#000000",
    description: "",
    body: "",
    petCharacterId: "",
    avatarImage: "",
  });
  const a = agents.createAgent(AgentInput.parse({ personaId: p.id, name: "a" }));
  if (!a) throw new Error("agent");
  expect(agents.deletePersona(p.id)).toBe("in_use");
  const room = chat.createRoom("r", [a.id]);
  if (typeof room === "string") throw new Error(room);
  expect(agents.deleteAgent(a.id)).toBe("in_use");
  expect(chat.updateRoom(room.id, { agentIds: [DEFAULT_AGENT_ID] })).toMatchObject({ agentIds: [DEFAULT_AGENT_ID] });
  expect(agents.deleteAgent(a.id)).toBeNull();
  expect(agents.deletePersona(p.id)).toBeNull();
  expect(agents.deleteAgent(DEFAULT_AGENT_ID)).toBe("builtin");
  expect(chat.createRoom("x", ["missing"])).toBe("no_agent");
});

test("롤링 요약: 최근 N 개 밖의 분량이 임계치를 넘으면 요약하고, 이후 요청은 요약 + 미요약 원문만 보낸다", async () => {
  const { chat, calls, summaries, events } = setup();
  const room = chat.createRoom("s");
  if (typeof room === "string") throw new Error(room);

  await say(chat, room.id, "첫 번째 메시지입니다");
  await Bun.sleep(5);
  expect(summaries.get(room.id)).toBeNull(); // 최근 2개 밖에 아무것도 없음

  await say(chat, room.id, "두 번째 메시지입니다");
  for (let i = 0; i < 100 && !summaries.get(room.id); i++) await Bun.sleep(2);
  const s = summaries.get(room.id);
  expect(s?.summary).toStartWith("SUMMARY#");
  const summaryCall = calls.find((c) => c.instructions.startsWith("You maintain a running summary"));
  expect(summaryCall?.turns[0]?.text).toContain("User: 첫 번째 메시지입니다");
  expect(summaryCall?.turns[0]?.text).toContain("Agent PROPRIX: reply to 첫 번째 메시지입니다");
  expect(events.some((e) => e.type === "summary")).toBe(true);

  await say(chat, room.id, "세 번째");
  const last = calls.filter((c) => !c.instructions.startsWith("You maintain")).at(-1);
  expect(last?.instructions).toContain(`<summary>\n${s?.summary}`);
  // 요약된 첫 턴은 원문으로 다시 보내지 않는다
  expect(last?.turns.map((t) => t.text)).toEqual(["두 번째 메시지입니다", "reply to 두 번째 메시지입니다", "세 번째"]);
});

test("요약이 실패하면 이전 상태를 유지하고, 이력은 상한까지만 보낸다", async () => {
  const { chat, calls, summaries, failSummary } = setup({ recentMessages: 2, triggerChars: 1, hardCapMessages: 4 });
  failSummary(true);
  const room = chat.createRoom("f");
  if (typeof room === "string") throw new Error(room);
  for (const t of ["a1", "a2", "a3", "a4"]) {
    await say(chat, room.id, t);
    await Bun.sleep(3);
  }
  expect(summaries.get(room.id)).toBeNull();
  const chatCalls = calls.filter((c) => !c.instructions.startsWith("You maintain"));
  expect(chatCalls.at(-1)?.turns.length).toBeLessThanOrEqual(4);
  expect(chatCalls.at(-1)?.turns[0]?.role).toBe("user");
});

test("다시 받기·수정: 그 사용자 메시지 뒤 대화를 지우고 다시 답하며, 요약에 들어간 메시지는 고칠 수 없다", async () => {
  const { chat, calls, events } = setup({ recentMessages: 50, triggerChars: 1_000_000, hardCapMessages: 60 });
  const room = chat.createRoom("r");
  if (typeof room === "string") throw new Error(room);
  const first = await say(chat, room.id, "하나");
  const second = await say(chat, room.id, "둘");

  // 첫 답을 다시 받으면 첫 사용자 메시지부터 다시: 뒤의 "둘" 턴은 지워진다
  const again = chat.rewind(room.id, first.assistant.id, undefined, "m");
  if (typeof again === "string") throw new Error(again);
  expect(again.user.id).toBe(first.user.id);
  await chat.idle(room.id);
  expect(chat.messages(room.id).map((m) => m.content)).toEqual(["하나", "reply to 하나"]);
  const removed = events.find((e) => e.type === "messages_removed");
  expect(removed).toMatchObject({ ids: [first.assistant.id, second.user.id, second.assistant.id] });
  expect(calls.at(-1)?.turns.map((t) => t.text)).toEqual(["하나"]);

  // 사용자 메시지 수정: 내용이 바뀌고 같은 id 로 다시 답한다
  const edited = chat.rewind(room.id, first.user.id, "고친 하나", "m");
  if (typeof edited === "string") throw new Error(edited);
  await chat.idle(room.id);
  expect(chat.messages(room.id).map((m) => m.content)).toEqual(["고친 하나", "reply to 고친 하나"]);
  expect(chat.messages(room.id)[0]?.id).toBe(first.user.id);

  // 답에는 새 글을 줄 수 없고, 없는 메시지는 not_message
  const reply = chat.messages(room.id)[1] as Message;
  expect(chat.rewind(room.id, reply.id, "x", "m")).toBe("not_user");
  expect(chat.rewind(room.id, crypto.randomUUID(), undefined, "m")).toBe("not_message");
});

test("다시 받기: 이미 요약에 들어간 메시지는 summarized", async () => {
  const { chat, summaries } = setup();
  const room = chat.createRoom("s");
  if (typeof room === "string") throw new Error(room);
  const first = await say(chat, room.id, "첫 번째 메시지입니다");
  await say(chat, room.id, "두 번째 메시지입니다");
  for (let i = 0; i < 100 && !summaries.get(room.id); i++) await Bun.sleep(2);
  expect(chat.rewind(room.id, first.user.id, "x", "m")).toBe("summarized");
});

test("전역 지침은 instructions 에, 에이전트 추론 강도는 요청에 ('' = 보내지 않음)", async () => {
  const { agents, chat, calls } = setup();
  chat.globalInstructions = () => "GLOBAL-RULE";
  const agent = agents.createAgent(
    AgentInput.parse({ personaId: DEFAULT_PERSONA_ID, name: "강도", reasoningEffort: "high" }),
  );
  if (!agent) throw new Error("agent");
  const room = chat.createRoom("e", [agent.id]);
  if (typeof room === "string") throw new Error(room);
  await say(chat, room.id, "안녕");
  expect(calls.at(-1)?.instructions).toContain("GLOBAL-RULE");
  expect((calls.at(-1) as { reasoningEffort?: string }).reasoningEffort).toBe("high");

  const def = chat.createRoom("d");
  if (typeof def === "string") throw new Error(def);
  await say(chat, def.id, "hi");
  expect((calls.at(-1) as { reasoningEffort?: string }).reasoningEffort).toBeUndefined();
});

const NO_SUMMARY = { recentMessages: 2, triggerChars: 1_000_000, hardCapMessages: 60 };
const titleCalls = (calls: Call[]) => calls.filter((c) => c.instructions.startsWith("Write a short title")).length;
const settle = () => new Promise((r) => setTimeout(r, 20)); // 자동 제목은 응답이 끝난 뒤 뒤에서 돈다

test("자동 제목: 기본 이름 방은 첫 응답 뒤 한 번만 제목을 만들고 요약 예산으로 센다", async () => {
  const { chat, calls, db, events } = setup(NO_SUMMARY);
  const room = chat.createRoom("새 대화");
  if (typeof room === "string") throw new Error(room);
  await say(chat, room.id, "이어폰 추천해 줘");
  await settle();
  expect(chat.room(room.id)?.title).toBe("이어폰 비교");
  expect(events.some((e) => e.type === "rooms")).toBe(true);
  expect(titleCalls(calls)).toBe(1);
  expect(db.query("SELECT COUNT(*) AS n FROM usage_ledger WHERE feature = 'summary'").get()).toEqual({ n: 1 });
  await say(chat, room.id, "더 알려 줘");
  await settle();
  expect(titleCalls(calls)).toBe(1);
});

test("자동 제목: 이름을 지은 방은 요청하지 않고, 만드는 사이 이름을 바꾸면 그 이름을 지킨다", async () => {
  const { chat, calls, whenTitling } = setup(NO_SUMMARY);
  const named = chat.createRoom("내가 지은 이름");
  if (typeof named === "string") throw new Error(named);
  await say(chat, named.id, "안녕");
  await settle();
  expect(titleCalls(calls)).toBe(0);

  const room = chat.createRoom("새 대화");
  if (typeof room === "string") throw new Error(room);
  whenTitling(() => chat.updateRoom(room.id, { title: "직접 바꿈" }));
  await say(chat, room.id, "안녕");
  await settle();
  expect(titleCalls(calls)).toBe(1);
  expect(chat.room(room.id)?.title).toBe("직접 바꿈");
});

test("내장 웹 검색을 시작하면 상태가 바뀌고, 글이 나오면 답하는 중으로 돌아온다", async () => {
  const { chat, events } = setup(NO_SUMMARY);
  const room = chat.createRoom("검색");
  if (typeof room === "string") throw new Error(room);
  await say(chat, room.id, "[search] 오늘 날씨");
  const texts = events.flatMap((e) => (e.type === "agent_status" ? [e.status.text] : []));
  const at = texts.indexOf("웹 검색 실행 중");
  expect(at).toBeGreaterThan(-1);
  expect(texts.slice(at)).toContain("답하는 중");
});
