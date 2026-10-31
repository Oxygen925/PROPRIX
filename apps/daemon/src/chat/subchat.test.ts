// 서브 채팅 (P9b): 분기 시점까지 참조 사본, 요약 포함 규칙, 상한, 부모 불변, 기억 읽기 전용, 라운지·서브의 서브 막기
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Agent, AgentInput, type ServerEvent, SUBCHAT_REFERENCE_MAX } from "@proprix/shared";
import type { AiRequest } from "@proprix/siwc";
import { AgentStore, DEFAULT_PERSONA_ID } from "../agents/store";
import type { StreamOptions, StreamResult } from "../auth/account";
import { SummaryService } from "../context/summary";
import { LlmGate } from "../llm/gate";
import { migrate } from "../storage/db";
import { ChatService } from "./chat";
import { makeChatTools } from "./test-helpers";

const lastUser = (req: AiRequest) => {
  const u = [...(req.turns ?? [])].reverse().find((t) => t.role === "user");
  return u && "text" in u ? u.text : "";
};
const toolNames = (req?: AiRequest) => (req?.tools ?? []).map((t) => (t.type === "function" ? t.name : t.type));

function setup() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const requests: AiRequest[] = [];
  const llm = {
    async stream(req: AiRequest, opt: StreamOptions): Promise<StreamResult> {
      requests.push(structuredClone(req));
      const text = `답:${lastUser(req).slice(0, 40)}`;
      opt.onDelta(text);
      return {
        outcome: "completed",
        code: "",
        param: "",
        recovery: "none",
        http: 200,
        attempts: 1,
        chars: 0,
        requestId: "",
        items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
      };
    },
  };
  const events: ServerEvent[] = [];
  const emit = (e: ServerEvent) => events.push(e);
  const gate = new LlmGate(db, () => {});
  const agents = new AgentStore(db);
  const summaries = new SummaryService(db, llm, gate, emit, () => "a");
  const tools = makeChatTools(db, llm, gate, agents, emit);
  const chat = new ChatService(db, llm, gate, agents, summaries, tools, emit);
  const agent = agents.createAgent(
    AgentInput.parse({
      personaId: DEFAULT_PERSONA_ID,
      name: "봇",
      tools: ["memory_save", "memory_search", "memory_forget", "note_create"],
    }),
  ) as Agent;
  const room = chat.createRoom("부모", [agent.id]);
  if (typeof room === "string") throw new Error(room);
  const say = async (roomId: string, text: string) => {
    const r = chat.send(roomId, text, "m");
    if (typeof r === "string") throw new Error(r);
    await chat.idle(roomId);
  };
  return { db, chat, room, agent, agents, requests, say, tools };
}

test("분기 메시지까지만 참조하고, 서브에서 대화해도 부모는 그대로, 기억 저장 도구는 숨김·추출 안 함", async () => {
  const s = setup();
  await s.say(s.room.id, "첫째 질문");
  await s.say(s.room.id, "둘째 질문");
  await s.say(s.room.id, "셋째 질문");
  const parentMsgs = s.chat.messages(s.room.id);
  const fork = parentMsgs.find((m) => m.role === "assistant" && m.content.includes("둘째"));
  const sub = s.chat.createSubchat(s.room.id, { messageId: fork?.id });
  if (typeof sub === "string") throw new Error(sub);
  expect(sub).toMatchObject({
    parentRoomId: s.room.id,
    parentMessageId: fork?.id,
    parentTitle: "부모",
    title: "서브: 부모",
  });
  expect(sub.agentIds).toEqual([s.agent.id]);
  const ref = s.chat.reference(sub.id);
  expect(ref).toContain("첫째 질문");
  expect(ref).toContain("답:둘째 질문");
  expect(ref).not.toContain("셋째");

  await s.say(sub.id, "곁가지 이야기");
  const req = s.requests.findLast((r) => !r.instructions?.startsWith("Write a short title")); // 자동 제목 요청 제외
  expect(req?.instructions).toContain("# Parent conversation (reference only)");
  expect(req?.instructions).toContain("답:둘째 질문");
  expect(JSON.stringify(req?.turns)).not.toContain("첫째 질문"); // 이력이 아니라 참조로만
  expect(toolNames(req)).toEqual(expect.arrayContaining(["memory_search", "note_create"]));
  expect(toolNames(req)).not.toContain("memory_save");
  expect(toolNames(req)).not.toContain("memory_forget");
  expect(s.chat.messages(s.room.id)).toHaveLength(parentMsgs.length);
  expect(await s.tools.memory.extractNow(sub.id)).toMatchObject({ skipped: "subchat" });

  // 부모를 지워도 서브 채팅과 참조는 남는다
  s.chat.deleteRoom(s.room.id);
  expect(s.chat.room(sub.id)?.parentTitle).toBe("부모");
  expect(s.chat.reference(sub.id)).toContain("첫째 질문");
});

test("요약: 분기 시점 앞까지 덮은 요약은 넣고, 분기 뒤까지 덮은 요약은 넣지 않는다. 상한을 넘으면 오래된 것부터 줄인다", async () => {
  const s = setup();
  await s.say(s.room.id, "하나");
  await s.say(s.room.id, "둘");
  const msgs = s.chat.messages(s.room.id);
  const first = msgs[1];
  const last = msgs.at(-1);
  const setSummary = (until: number) =>
    s.db
      .query(
        "INSERT OR REPLACE INTO room_summaries (room_id, summary, covered_until, updated_at) VALUES ($r, 'EARLIER SUMMARY', $u, 0)",
      )
      .run({ r: s.room.id, u: until });
  setSummary(first?.createdAt ?? 0);
  const a = s.chat.createSubchat(s.room.id, {});
  if (typeof a === "string") throw new Error(a);
  expect(s.chat.reference(a.id)).toContain("EARLIER SUMMARY");
  expect(s.chat.reference(a.id)).not.toContain("하나"); // 요약이 덮은 부분은 요약으로
  expect(s.chat.reference(a.id)).toContain("둘");
  setSummary(last?.createdAt ?? 0);
  const b = s.chat.createSubchat(s.room.id, { messageId: first?.id });
  if (typeof b === "string") throw new Error(b);
  expect(s.chat.reference(b.id)).not.toContain("EARLIER SUMMARY");
  expect(s.chat.reference(b.id)).toContain("하나");

  // 상한
  const big = setup();
  for (let i = 0; i < 6; i++) await big.say(big.room.id, `${i}번 ${"가".repeat(9000)}`);
  const c = big.chat.createSubchat(big.room.id, {});
  if (typeof c === "string") throw new Error(c);
  const ref = big.chat.reference(c.id);
  expect(ref.length).toBeLessThanOrEqual(SUBCHAT_REFERENCE_MAX + 100);
  expect(ref).toContain("older messages omitted");
  expect(ref).toContain("5번");
  expect(ref).not.toContain("0번");
});

test("자동 제목: 기본 이름의 서브 채팅에는 붙이고, 이름을 지은 서브 채팅은 그대로 둔다", async () => {
  const s = setup();
  await s.say(s.room.id, "안녕");
  const named = s.chat.createSubchat(s.room.id, { title: "곁가지" });
  const unnamed = s.chat.createSubchat(s.room.id, {});
  if (typeof named === "string" || typeof unnamed === "string") throw new Error("서브 채팅 실패");
  expect(unnamed.title).toBe("서브: 부모");
  await s.say(named.id, "질문");
  await s.say(unnamed.id, "질문");
  await Bun.sleep(10);
  const title = (id: string) => (s.db.query("SELECT title FROM rooms WHERE id = ?").get(id) as { title: string }).title;
  expect(title(named.id)).toBe("곁가지");
  expect(title(unnamed.id)).not.toBe("서브: 부모");
  expect(title(unnamed.id)).not.toBe("");
});

test("라운지·서브의 서브·없는 메시지는 막는다, 참여자는 바꿔 만들 수 있다", async () => {
  const s = setup();
  await s.say(s.room.id, "안녕");
  const other = s.agents.createAgent(AgentInput.parse({ personaId: DEFAULT_PERSONA_ID, name: "둘째" })) as Agent;
  const sub = s.chat.createSubchat(s.room.id, { agentIds: [other.id], title: "곁가지" });
  if (typeof sub === "string") throw new Error(sub);
  expect(sub).toMatchObject({ title: "곁가지", agentIds: [other.id] });
  expect(s.chat.createSubchat(sub.id, {})).toBe("nested");
  expect(s.chat.createSubchat(s.room.id, { messageId: crypto.randomUUID() })).toBe("not_message");
  const lounge = s.chat.createRoom("라운지", [s.agent.id]);
  if (typeof lounge === "string") throw new Error(lounge);
  s.db.query("UPDATE rooms SET kind = 'lounge' WHERE id = $id").run({ id: lounge.id });
  expect(s.chat.createSubchat(lounge.id, {})).toBe("lounge");
});
