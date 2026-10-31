// daemon API e2e (모의 SIWC): 로그인 → 모델 → 채팅 스트림(WS) → 사용량 한도 일시정지 → 재개 → 로그아웃
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MockSiwc, startMockSiwc } from "@proprix/mock-siwc";
import {
  type Agent,
  DEFAULT_BACKUP,
  DEFAULT_BUDGETS,
  DEFAULT_LOUNGE,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_PROACTIVE,
  DEFAULT_RESEARCH,
  type Debate,
  type Message,
  type Persona,
  type Room,
  type ServerEvent,
  type Settings,
  type ToolCall,
} from "@proprix/shared";
import { DEFAULT_AGENT_ID } from "./agents/store";
import { type App, createApp } from "./app";
import { MemorySecretStore } from "./auth/secret-store";
import { loadConfig } from "./config";

const TOKEN = "e2e-token-0123456789";
let mock: MockSiwc;
let app: App;
let dir: string;
let ws: WebSocket;
const events: ServerEvent[] = [];

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${app.api.url}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers },
  });
const post = (path: string, body: unknown = {}) => api(path, { method: "POST", body: JSON.stringify(body) });

async function waitFor<T extends ServerEvent>(pred: (e: ServerEvent) => e is T, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const hit = events.find(pred);
    if (hit) {
      events.splice(events.indexOf(hit), 1);
      return hit;
    }
    if (Date.now() - start > timeoutMs) throw new Error("이벤트 대기 시간 초과");
    await Bun.sleep(10);
  }
}

const doneMessage =
  (id: string) =>
  (e: ServerEvent): e is Extract<ServerEvent, { type: "message" }> =>
    e.type === "message" && e.message.id === id;

// 보내고, 화자가 정해져 생긴 첫 응답 메시지(streaming)를 기다린다
async function say(roomId: string, body: unknown): Promise<{ user: Message; assistant: Message }> {
  const res = await post(`/rooms/${roomId}/messages`, body);
  if (!res.ok) throw new Error(`전송 실패 ${res.status}`);
  const { user } = (await res.json()) as { user: Message };
  const ev = await waitFor(
    (e): e is Extract<ServerEvent, { type: "message" }> =>
      e.type === "message" &&
      e.message.roomId === roomId &&
      e.message.role === "assistant" &&
      e.message.status === "streaming",
  );
  return { user, assistant: ev.message };
}

beforeAll(async () => {
  mock = await startMockSiwc();
  dir = mkdtempSync(join(tmpdir(), "proprix-e2e-"));
  app = createApp(
    { ...loadConfig({}), port: 0, apiToken: TOKEN, dataDir: dir, siwcBase: mock.url, callbackPort: 0 },
    { secretStore: new MemorySecretStore(), retryBaseMs: 1 },
  );
  ws = new WebSocket(`${app.api.url.replace("http", "ws")}/api/ws`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  } as never);
  ws.onmessage = (e) => events.push(JSON.parse(String(e.data)));
  await waitFor((e): e is ServerEvent => e.type === "hello");
});

afterAll(async () => {
  ws.close();
  await app.stop();
  await mock.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("로그인 전: 계정 상태, 모델 목록은 재로그인 필요", async () => {
  expect(await (await api("/account")).json()).toMatchObject({ registered: false, signedIn: false, mock: true });
  const res = await api("/models");
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ error: { code: "upstream", detail: { recovery: "re_sign_in" } } });
});

test("API 로 로그인 → account 이벤트", async () => {
  const { authorizeUrl } = (await (await post("/account/signin")).json()) as { authorizeUrl: string };
  expect((await post("/account/signin")).status).toBe(409); // 이미 진행 중
  const loc = (await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location") ?? "";
  await fetch(loc);
  const ev = await waitFor((e): e is Extract<ServerEvent, { type: "account" }> => e.type === "account" && !!e.signIn);
  expect(ev.signIn).toEqual({ ok: true, code: "ok" });
  expect(ev.account).toMatchObject({ signedIn: true, planUsage: true, welcomeShown: false });

  await post("/account/welcome-shown");
  expect(await (await api("/account")).json()).toMatchObject({ welcomeShown: true });
  expect(await (await api("/models")).json()).toEqual([{ slug: "mock-chat", displayName: "Mock Chat", efforts: [] }]);
});

test("설정: 모델 저장, 예산·라운지 부분 변경, 잘못된 값 거부", async () => {
  const patch = (body: unknown) => api("/settings", { method: "PATCH", body: JSON.stringify(body) });
  expect(await (await patch({ model: "mock-chat" })).json()).toEqual({
    backup: DEFAULT_BACKUP,
    model: "mock-chat",
    instructions: "",
    budgets: DEFAULT_BUDGETS,
    lounge: DEFAULT_LOUNGE,
    memory: DEFAULT_MEMORY_SETTINGS,
    proactive: DEFAULT_PROACTIVE,
    research: DEFAULT_RESEARCH,
    updateCheck: true,
  });
  expect((await patch({ model: 3 })).status).toBe(400);
  expect((await patch({ budgets: { router: 0 } })).status).toBe(400);
  expect((await patch({ lounge: { startHour: 22, endHour: 9 } })).status).toBe(400);
  // 바꾼 항목만 합쳐진다
  const next = (await (await patch({ budgets: { chat: 500 }, lounge: { turns: 4 } })).json()) as Settings;
  expect(next.budgets).toEqual({ ...DEFAULT_BUDGETS, chat: 500 });
  expect(next.lounge).toEqual({ ...DEFAULT_LOUNGE, turns: 4 });
  await patch({ budgets: { chat: null }, lounge: { turns: DEFAULT_LOUNGE.turns } });
  expect(await (await api("/settings")).json()).toEqual({
    backup: DEFAULT_BACKUP,
    model: "mock-chat",
    instructions: "",
    budgets: DEFAULT_BUDGETS,
    lounge: DEFAULT_LOUNGE,
    memory: DEFAULT_MEMORY_SETTINGS,
    proactive: DEFAULT_PROACTIVE,
    research: DEFAULT_RESEARCH,
    updateCheck: true,
  });
  // 전역 지침: 저장·상한
  expect(((await (await patch({ instructions: "존댓말로 답해" })).json()) as Settings).instructions).toBe(
    "존댓말로 답해",
  );
  expect((await patch({ instructions: "x".repeat(4001) })).status).toBe(400);
  await patch({ instructions: "" });
  const usage = (await (await api("/usage")).json()) as { features: { feature: string; limit: number | null }[] };
  expect(usage.features.find((f) => f.feature === "router")?.limit).toBe(DEFAULT_BUDGETS.router);
});

test("채팅: 스트림 델타와 완료, 이력 전송", async () => {
  const [room] = (await (await api("/rooms")).json()) as Room[];
  if (!room) throw new Error("기본 방 없음");
  const sent = await say(room.id, { text: "안녕", model: "mock-chat" });
  expect(sent.assistant.status).toBe("streaming");
  const done = await waitFor(doneMessage(sent.assistant.id));
  expect(done.message).toMatchObject({ status: "complete", content: "echo: 안녕" });
  const deltas = events.filter((e) => e.type === "delta" && e.messageId === sent.assistant.id);
  expect(deltas.length).toBeGreaterThan(1);
  events.length = 0;

  const second = await say(room.id, { text: "두 번째", model: "mock-chat" });
  await waitFor(doneMessage(second.assistant.id));
  // 이전 턴(user·assistant) + 새 user
  expect(mock.stats.lastResponsesBody).toMatchObject({
    input: [
      { role: "user", content: "안녕" },
      { role: "assistant", content: "echo: 안녕" },
      { role: "user", content: "두 번째" },
    ],
  });
  const stored = (await (await api(`/rooms/${room.id}/messages`)).json()) as Message[];
  expect(stored.map((m) => m.status)).toEqual(["complete", "complete", "complete", "complete"]);
});

test("사용량 한도: 일부 응답 보존, 전역 일시정지, 재개", async () => {
  const room = (await (await post("/rooms", { title: "한도" })).json()) as Room;
  mock.setModes({ responses: "usage_limit" });
  const a = await say(room.id, { text: "abcdefghijkl", model: "mock-chat" });
  const done = await waitFor(doneMessage(a.assistant.id));
  expect(done.message).toMatchObject({
    status: "partial",
    recovery: "usage_limit",
    errorCode: "subscription_sharing_usage_limit_exceeded",
  });
  expect(await (await api("/llm")).json()).toMatchObject({ paused: true });

  mock.reset();
  const before = mock.stats.counts.responses ?? 0;
  const b = await say(room.id, { text: "again", model: "mock-chat" });
  expect((await waitFor(doneMessage(b.assistant.id))).message).toMatchObject({
    status: "failed",
    recovery: "usage_limit",
  });
  expect(mock.stats.counts.responses ?? 0).toBe(before); // 일시정지 중에는 서버로 보내지 않는다

  expect(await (await post("/llm/resume")).json()).toMatchObject({ paused: false });
  const c = await say(room.id, { text: "ok", model: "mock-chat" });
  expect((await waitFor(doneMessage(c.assistant.id))).message.status).toBe("complete");
});

test("중지와 동시 전송 거부", async () => {
  const room = (await (await post("/rooms", { title: "중지" })).json()) as Room;
  mock.setModes({ responses: "slow" });
  const a = await say(room.id, { text: "a long text to stream slowly", model: "mock-chat" });
  expect((await post(`/rooms/${room.id}/messages`, { text: "x", model: "mock-chat" })).status).toBe(409);
  await Bun.sleep(250);
  expect(await (await post(`/rooms/${room.id}/cancel`)).json()).toEqual({ cancelled: true });
  const done = await waitFor(doneMessage(a.assistant.id));
  expect(done.message.status).toBe("partial");
  expect(done.message.errorCode).toBe("cancelled");
  mock.reset();
});

test("검증 오류·없는 방", async () => {
  expect((await post("/rooms/00000000-0000-0000-0000-000000000000/messages", { text: "x", model: "m" })).status).toBe(
    404,
  );
  const [room] = (await (await api("/rooms")).json()) as Room[];
  expect((await post(`/rooms/${room?.id}/messages`, { text: "  ", model: "m" })).status).toBe(400);
  expect((await api(`/rooms/${room?.id}/messages`, { method: "POST", body: "{bad" })).status).toBe(400);
});

test("페르소나·에이전트: 생성 → 방 지정 → 대화에 반영 → 삭제 제약", async () => {
  const personas = (await (await api("/personas")).json()) as Persona[];
  expect(personas[0]).toMatchObject({ name: "PROPRIX", builtin: true });

  const bad = await post("/personas", { name: "x", emoji: "🐱🐱", color: "red", body: "" });
  expect(bad.status).toBe(400);
  const cat = (await (
    await post("/personas", { name: "고양이", emoji: "🐱", color: "#ffaa00", body: "- 말투: 끝에 냥" })
  ).json()) as Persona;
  const agent = (await (
    await post("/agents", { personaId: cat.id, name: "냥비서", role: "일정을 챙긴다" })
  ).json()) as Agent;
  expect(agent).toMatchObject({ name: "냥비서", model: "", builtin: false });

  const room = (await (await post("/rooms", { title: "고양이 방", agentIds: [agent.id] })).json()) as Room;
  expect(room.agentIds).toEqual([agent.id]);
  const sent = await say(room.id, { text: "냥", model: "mock-chat" });
  expect(sent.assistant.agentId).toBe(agent.id);
  await waitFor(doneMessage(sent.assistant.id));
  const instructions = String((mock.stats.lastResponsesBody as { instructions?: string }).instructions);
  expect(instructions).toContain('You are "냥비서"');
  expect(instructions).toContain("일정을 챙긴다");
  expect(instructions).toContain("- 말투: 끝에 냥");

  expect((await api(`/personas/${cat.id}`, { method: "DELETE" })).status).toBe(409); // 에이전트가 사용 중
  expect((await api(`/agents/${agent.id}`, { method: "DELETE" })).status).toBe(409); // 방이 사용 중
  expect((await api(`/personas/${personas[0]?.id}`, { method: "DELETE" })).status).toBe(409); // 기본
  const moved = (await (
    await api(`/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ agentIds: [DEFAULT_AGENT_ID] }) })
  ).json()) as Room;
  expect(moved.agentIds).toEqual([DEFAULT_AGENT_ID]);
  expect((await api(`/agents/${agent.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`/personas/${cat.id}`, { method: "DELETE" })).status).toBe(200);
});

test("페르소나 가져오기·내보내기 (JSON, persona.md)", async () => {
  const md = (await (
    await post("/personas/import", { format: "markdown", text: "- 이름: 윈도울링 (Windowling)\n- 말투: 존댓말" })
  ).json()) as Persona;
  expect(md).toMatchObject({ name: "윈도울링 (Windowling)", body: "- 이름: 윈도울링 (Windowling)\n- 말투: 존댓말" });

  const exported = await api(`/personas/${md.id}/export`);
  expect(exported.headers.get("content-disposition")).toContain("filename*=UTF-8''");
  const file = await exported.json();
  expect(file).toMatchObject({ format: "proprix.persona", version: 1, persona: { name: md.name } });
  const again = (await (await post("/personas/import", { format: "json", data: file })).json()) as Persona;
  expect(again.id).not.toBe(md.id);
  expect(again.body).toBe(md.body);

  expect(await (await api(`/personas/${md.id}/export?format=markdown`)).text()).toBe(`${md.body}\n`);
  expect((await post("/personas/import", { format: "json", data: { format: "nope" } })).status).toBe(400);
});

test("미리보기: 저장하지 않은 페르소나로 한 턴", async () => {
  const before = mock.stats.counts.responses ?? 0;
  const res = await post("/agents/preview", {
    persona: { name: "임시", emoji: "✨", color: "#123456", body: "- 말투: 짧게" },
    name: "임시",
    text: "미리보기",
    model: "mock-chat",
  });
  expect(await res.json()).toMatchObject({ text: "echo: 미리보기", outcome: "completed" });
  expect(mock.stats.counts.responses).toBe(before + 1);
  expect(String((mock.stats.lastResponsesBody as { instructions?: string }).instructions)).toContain("- 말투: 짧게");
});

test("도구: 쓰기 확인 → 결정 API → 결과를 붙여 다시 요청, 메모 API", async () => {
  expect(((await (await api("/tools")).json()) as { name: string }[]).map((t) => t.name)).toContain("note_create");
  const room = (await (await post("/rooms", { title: "도구" })).json()) as Room; // 기본 에이전트: 로컬 도구 전부
  mock.reset();
  events.length = 0;
  const sent = await say(room.id, {
    text: '[say+tool:note_create {"title":"장보기","body":"우유"}]',
    model: "mock-chat",
  });

  const pending = await waitFor(
    (e): e is Extract<ServerEvent, { type: "tool" }> => e.type === "tool" && e.call.status === "pending",
  );
  expect(pending.call).toMatchObject({ name: "note_create", kind: "write", args: '{"title":"장보기","body":"우유"}' });
  expect((await post(`/tool-calls/${pending.call.id}/decision`, { approve: true })).status).toBe(200);
  expect((await post(`/tool-calls/${pending.call.id}/decision`, { approve: true })).status).toBe(409);

  const done = await waitFor(doneMessage(sent.assistant.id));
  expect(done.message.status).toBe("complete");
  expect(done.message.content).toStartWith("확인해 볼게요.\n\ntool result: ");
  const bodies = mock.stats.responsesBodies as { tools?: unknown[]; input: { type?: string }[]; include?: string[] }[];
  expect(bodies).toHaveLength(2);
  expect(bodies[0]?.include).toEqual(["reasoning.encrypted_content"]);
  expect(bodies[1]?.input.slice(-3).map((i) => i.type)).toEqual(["message", "function_call", "function_call_output"]);

  const notes = (await (await api("/notes")).json()) as { id: string; title: string }[];
  expect(notes.map((n) => n.title)).toEqual(["장보기"]);
  expect((await (await api(`/rooms/${room.id}/tool-calls`)).json()) as unknown[]).toHaveLength(1);
  expect((await api(`/notes/${notes[0]?.id}`, { method: "DELETE" })).status).toBe(200);
  expect(await (await api("/notes")).json()).toEqual([]);
});

test("도구: 웹 검색은 에이전트 설정이 켜져야 선언되고, 출처를 메시지에 남긴다", async () => {
  const agent = (await (
    await post("/agents", { personaId: "00000000-0000-4000-8000-000000000001", name: "검색봇", webSearch: true })
  ).json()) as Agent;
  expect(agent).toMatchObject({ webSearch: true, autoApproveWrites: false });
  expect(agent.tools).toContain("note_create");
  const room = (await (await post("/rooms", { title: "검색", agentIds: [agent.id] })).json()) as Room;
  mock.reset();
  const sent = await say(room.id, { text: "[search] bun", model: "mock-chat" });
  const done = await waitFor(doneMessage(sent.assistant.id));
  expect(done.message.sources).toEqual([{ url: "https://bun.sh/", title: "Bun" }]);
  const tools = (mock.stats.lastResponsesBody as { tools: { type: string }[] }).tools;
  expect(tools.some((t) => t.type === "web_search")).toBe(true);
});

test("그룹챗: 멘션, 라우터 실패 시 라운드로빈, 위임 (모의 서버)", async () => {
  const personaId = "00000000-0000-4000-8000-000000000001";
  const alpha = (await (await post("/agents", { personaId, name: "알파" })).json()) as Agent;
  const beta = (await (await post("/agents", { personaId, name: "베타", role: "요약 담당" })).json()) as Agent;
  expect(alpha.tools).toContain("delegate_to_agent"); // 새 에이전트는 위임 기본 켬
  expect((await post("/rooms", { agentIds: [alpha.id, alpha.id] })).status).toBe(400);
  expect((await post("/rooms", { agentIds: [alpha.id], chainLimit: 9 })).status).toBe(400);
  const room = (await (
    await post("/rooms", { title: "그룹", agentIds: [alpha.id, beta.id], chainLimit: 2 })
  ).json()) as Room;
  expect(room).toMatchObject({ agentIds: [alpha.id, beta.id], chainLimit: 2, running: false });
  const turnEnd = (e: ServerEvent): e is Extract<ServerEvent, { type: "turn" }> =>
    e.type === "turn" && e.roomId === room.id && !e.running;
  mock.reset();

  const first = await say(room.id, { text: "@베타 안녕", model: "mock-chat" });
  expect(first.assistant.agentId).toBe(beta.id);
  await waitFor(turnEnd);
  const firstBodies = mock.stats.responsesBodies as { instructions?: string }[];
  expect(firstBodies).toHaveLength(1); // 멘션이 있으면 라우터를 부르지 않는다
  expect(firstBodies[0]?.instructions).toStartWith('You are "베타"');

  // 멘션 없음 → 라우터 호출 (모의 서버는 도구를 부르지 않음) → 라운드로빈: 베타 다음 알파
  const second = await say(room.id, { text: "다들 뭐해", model: "mock-chat" });
  expect(second.assistant.agentId).toBe(alpha.id);
  await waitFor(turnEnd);
  const bodies = mock.stats.responsesBodies as {
    instructions?: string;
    input: { role?: string; content?: string }[];
  }[];
  expect(bodies[1]?.instructions).toStartWith("You route messages");
  // 알파는 베타의 말을 화자 태그가 붙은 데이터로 받는다
  expect(bodies[2]?.instructions).toContain("# Group chat");
  expect(bodies[2]?.input.map((i) => i.content)).toContain(
    '<agent_message from="베타">\necho: @베타 안녕\n</agent_message>',
  );

  // 위임: 알파 → 베타 (격리 컨텍스트) → 결과를 받아 답한다
  mock.reset();
  const third = await say(room.id, {
    text: '@알파 [tool:delegate_to_agent {"agent":"베타","task":"오늘 할 일 요약"}]',
    model: "mock-chat",
  });
  const done = await waitFor(doneMessage(third.assistant.id));
  await waitFor(turnEnd);
  expect(done.message).toMatchObject({ agentId: alpha.id, status: "complete" });
  expect(done.message.content).toStartWith("tool result: ");
  expect(done.message.content).toContain("오늘 할 일 요약");
  const calls = (await (await api(`/rooms/${room.id}/tool-calls`)).json()) as ToolCall[];
  expect(calls.map((c) => [c.name, c.status, c.parentId, c.agentId])).toEqual([
    ["delegate_to_agent", "done", "", alpha.id],
  ]);
  const sub = (mock.stats.responsesBodies as { instructions?: string; input: unknown[] }[])[1];
  expect(sub?.instructions).toContain("# Delegated task");
  expect(sub?.input).toEqual([{ role: "user", content: 'Task from agent "알파":\n<task>\n오늘 할 일 요약\n</task>' }]);

  // 참여자 변경·연쇄 상한 변경
  const patched = (await (
    await api(`/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ agentIds: [beta.id], chainLimit: 1 }) })
  ).json()) as Room;
  expect(patched).toMatchObject({ agentIds: [beta.id], chainLimit: 1 });
});

test("토론: API 로 시작 → 진행 이벤트 → 끝, 검증 오류 (모의 서버)", async () => {
  const personaId = "00000000-0000-4000-8000-000000000001";
  const pro = (await (await post("/agents", { personaId, name: "찬성" })).json()) as Agent;
  const con = (await (await post("/agents", { personaId, name: "반대" })).json()) as Agent;
  const room = (await (await post("/rooms", { title: "토론방", agentIds: [pro.id, con.id] })).json()) as Room;
  const body = {
    topic: "아침형 인간이 유리한가",
    agentIds: [pro.id, con.id],
    moderatorId: DEFAULT_AGENT_ID,
    rounds: 1,
    model: "mock-chat",
  };
  expect((await post(`/rooms/${room.id}/debates`, { ...body, rounds: 9 })).status).toBe(400);
  expect((await post(`/rooms/${room.id}/debates`, { ...body, agentIds: [pro.id, DEFAULT_AGENT_ID] })).status).toBe(400);

  events.length = 0;
  const started = (await (await post(`/rooms/${room.id}/debates`, body)).json()) as Debate;
  expect(started).toMatchObject({ mode: "debate", status: "running", round: 0, moderatorId: DEFAULT_AGENT_ID });
  const end = await waitFor(
    (e): e is Extract<ServerEvent, { type: "debate" }> => e.type === "debate" && e.debate.status !== "running",
  );
  expect(end.debate).toMatchObject({ id: started.id, status: "done", round: 2 });
  const list = (await (await api(`/rooms/${room.id}/debates`)).json()) as Debate[];
  expect(list.map((d) => d.status)).toEqual(["done"]);
  const msgs = (await (await api(`/rooms/${room.id}/messages`)).json()) as Message[];
  expect(msgs.map((m) => m.debateRound)).toEqual([0, 0, 1, 1, 2]);
  expect(msgs.every((m) => m.debateId === started.id && m.status === "complete")).toBe(true);
});

test("리마인더: 대화로 예약(확인 없이) → 목록 → 취소 (모의 서버)", async () => {
  // 리마인더 도구는 새 에이전트의 기본 도구 (기존 에이전트는 편집기에서 켠다)
  const agent = (await (
    await post("/agents", { personaId: "00000000-0000-4000-8000-000000000001", name: "알림이" })
  ).json()) as Agent;
  expect(agent.tools).toContain("reminder_create");
  const room = (await (await post("/rooms", { title: "리마인더", agentIds: [agent.id] })).json()) as Room;
  const d = new Date(Date.now() + 2 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 09:00`;
  const sent = await say(room.id, {
    text: `[tool:reminder_create {"text":"약 먹기","when":"${when}","repeat":"daily"}]`,
    model: "mock-chat",
  });
  await waitFor(doneMessage(sent.assistant.id));
  const list = (await (await api("/reminders")).json()) as {
    id: string;
    text: string;
    repeat: string;
    roomId: string;
  }[];
  expect(list).toMatchObject([{ text: "약 먹기", repeat: "daily", roomId: room.id }]);
  expect((await api(`/reminders/${list[0]?.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`/reminders/${list[0]?.id}`, { method: "DELETE" })).status).toBe(404);
  expect(await (await api("/reminders")).json()).toEqual([]);
});

test("메모리: 지금 추출 → 목록 → 다음 요청에 주입 → 수정·삭제", async () => {
  const room = (await (await post("/rooms", { title: "기억" })).json()) as Room;
  const extracted = {
    memories: [
      {
        kind: "preference",
        scope: "shared",
        content: "녹차를 좋아한다",
        content_en: "Likes green tea",
        importance: 4,
        valid_days: null,
        replaces: [],
      },
    ],
  };
  // 대화 안의 표시를 모의 서버가 추출 요청에서 save_memories 호출로 바꾼다 (채팅 요청에는 그 도구가 없어 그냥 echo)
  const first = await say(room.id, {
    text: `나 녹차 좋아해 [tool:save_memories ${JSON.stringify(extracted)}]`,
    model: "mock-chat",
  });
  await waitFor(doneMessage(first.assistant.id));

  expect(await (await post(`/rooms/${room.id}/extract-memories`)).json()).toEqual({
    saved: 1,
    superseded: 0,
    skipped: "",
  });
  expect(await (await post(`/rooms/${room.id}/extract-memories`)).json()).toMatchObject({ skipped: "nothing_new" });
  const [m] = (await (await api("/memories")).json()) as { id: string; content: string; scope: string }[];
  expect(m).toMatchObject({ content: "녹차를 좋아한다", scope: "shared" });

  const next = await say(room.id, { text: "내가 뭘 좋아하지?", model: "mock-chat" });
  const done = await waitFor(doneMessage(next.assistant.id));
  expect(done.message.memoryIds).toEqual([m?.id ?? ""]);
  expect(String((mock.stats.lastResponsesBody as { instructions?: string }).instructions)).toContain("Likes green tea");

  const edited = (await (
    await api(`/memories/${m?.id}`, {
      method: "PUT",
      body: JSON.stringify({
        scope: "shared",
        kind: "preference",
        content: "홍차를 좋아한다",
        contentEn: "Likes green tea",
        importance: 4,
      }),
    })
  ).json()) as { contentEn: string };
  expect(edited.contentEn).toBe(""); // 원문이 바뀌면 영어본은 다시 정규화 대상
  expect(
    (await api("/memories", { method: "POST", body: JSON.stringify({ scope: "nobody", kind: "fact", content: "x" }) }))
      .status,
  ).toBe(400);
  expect((await api(`/memories/${m?.id}`, { method: "DELETE" })).status).toBe(200);
  expect(await (await api("/memories")).json()).toEqual([]);
});

test("로그아웃: 진행 중 스트림을 먼저 멈춘 뒤 revoke", async () => {
  const room = (await (await post("/rooms", { title: "로그아웃" })).json()) as Room;
  mock.setModes({ responses: "slow" });
  const a = await say(room.id, { text: "streaming during sign out", model: "mock-chat" });
  await Bun.sleep(150);
  expect(await (await post("/account/signout", { forceLocal: false })).json()).toEqual({ ok: true, code: "" });
  // 응답이 돌아왔을 때는 이미 스트림이 중지되고 결과가 저장되어 있어야 한다
  const stored = (await (await api(`/rooms/${room.id}/messages`)).json()) as Message[];
  expect(stored.find((m) => m.id === a.assistant.id)).toMatchObject({ status: "partial", errorCode: "cancelled" });
  mock.reset();
  const ev = await waitFor((e): e is Extract<ServerEvent, { type: "account" }> => e.type === "account" && !e.signIn);
  expect(ev.account).toMatchObject({ registered: true, signedIn: false });
});

test("/ 명령: 저장·충돌 409·예약어 400·미리보기·이벤트", async () => {
  const body = (name: string, template = "리뷰: $1") => ({ name, template });
  const created = await post("/commands", body("Review"));
  expect(created.status).toBe(200);
  const cmd = (await created.json()) as { id: string; name: string };
  await waitFor((e): e is Extract<ServerEvent, { type: "commands" }> => e.type === "commands");
  expect((await post("/commands", body("review"))).status).toBe(409);
  expect((await post("/commands", body("help"))).status).toBe(400);
  expect((await post("/commands", body("1bad"))).status).toBe(400);
  const preview = await post("/commands/preview", { template: "$1 / $ARGUMENTS", args: '"a b" c' });
  expect(await preview.json()).toEqual({ text: 'a b / "a b" c', required: 1, missing: [], tooLong: false });
  const put = await api(`/commands/${cmd.id}`, { method: "PUT", body: JSON.stringify(body("review", "새 $1")) });
  expect(await put.json()).toMatchObject({ name: "review", template: "새 $1" });
  expect(((await (await api("/commands")).json()) as unknown[]).length).toBe(1);
  expect((await api(`/commands/${cmd.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`/commands/${cmd.id}`, { method: "DELETE" })).status).toBe(404);
});
