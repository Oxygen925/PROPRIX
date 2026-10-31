// 메모리 추출·정규화·주입 (가짜 LLM)
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Agent, AgentInput, SHARED_SCOPE } from "@proprix/shared";
import type { AiRequest } from "@proprix/siwc";
import { AgentStore, DEFAULT_PERSONA_ID } from "../agents/store";
import type { StreamOptions, StreamResult } from "../auth/account";
import { LlmGate } from "../llm/gate";
import { migrate } from "../storage/db";
import { DEFAULT_MEMORY_OPTIONS, MemoryService } from "./service";
import { MemoryStore } from "./store";

type Reply = { call?: { name: string; args: unknown }; outcome?: StreamResult["outcome"] };

function setup(
  reply: (req: AiRequest) => Reply,
  isolated = false,
  chunkChars = DEFAULT_MEMORY_OPTIONS.chunkChars,
  defaultModel = "m",
) {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  const requests: AiRequest[] = [];
  const llm = {
    async stream(req: AiRequest, _opt: StreamOptions): Promise<StreamResult> {
      requests.push(req);
      const r = reply(req);
      const items = r.call
        ? [{ type: "function_call", call_id: "c", name: r.call.name, arguments: JSON.stringify(r.call.args) }]
        : [];
      return {
        outcome: r.outcome ?? "completed",
        code: r.outcome ? "x" : "",
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
  const agents = new AgentStore(db);
  const agent = agents.createAgent(
    AgentInput.parse({ personaId: DEFAULT_PERSONA_ID, name: "비서", memoryIsolated: isolated }),
  ) as Agent;
  const store = new MemoryStore(db);
  const events: string[] = [];
  const memory = new MemoryService(
    db,
    store,
    llm,
    new LlmGate(db, () => {}),
    agents,
    () => defaultModel,
    (e) => events.push(e.type),
    {
      ...DEFAULT_MEMORY_OPTIONS,
      idleMs: 20,
      chunkChars,
    },
  );
  const roomId = crypto.randomUUID();
  db.query("INSERT INTO rooms (id, title, created_at, updated_at) VALUES (?, 't', 0, 0)").run(roomId);
  db.query("INSERT INTO room_members (room_id, agent_id, position) VALUES (?, ?, 0)").run(roomId, agent.id);
  let t = 0;
  const say = (role: "user" | "assistant", content: string) =>
    db
      .query(
        `INSERT INTO messages (id, room_id, role, agent_id, content, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'complete', ?)`,
      )
      .run(crypto.randomUUID(), roomId, role, role === "user" ? "" : agent.id, content, ++t);
  return { db, store, memory, agent, roomId, requests, say, events };
}

const mem = (content: string, patch: Record<string, unknown> = {}) => ({
  kind: "preference",
  scope: "shared",
  content,
  content_en: "",
  importance: 3,
  valid_days: null,
  replaces: [],
  ...patch,
});
const save = (memories: unknown[]) => ({ call: { name: "save_memories", args: { memories } } });

test("추출: 공용·에이전트 범위로 저장하고, 같은 대화는 다시 처리하지 않는다", async () => {
  const s = setup(() =>
    save([
      mem("커피를 좋아한다", { content_en: "Likes coffee", importance: 4 }),
      mem("나를 '대장'이라 부른다", { kind: "relationship", scope: "agent" }),
      mem("다음 주 금요일 치과 예약", { kind: "event", valid_days: 10 }),
    ]),
  );
  s.say("user", "나 커피 좋아해. 그리고 날 대장이라고 불러줘");
  s.say("assistant", "알겠어요, 대장!");
  expect(await s.memory.extractNow(s.roomId)).toEqual({ saved: 3, superseded: 0, skipped: "" });
  const all = s.store.list();
  expect(all.find((m) => m.kind === "relationship")?.scope).toBe(s.agent.id);
  expect(all.find((m) => m.content.startsWith("커피"))?.scope).toBe(SHARED_SCOPE);
  expect(all.find((m) => m.kind === "event")?.validUntil).toBeGreaterThan(Date.now());
  expect(s.requests[0]?.tools?.[0]).toMatchObject({ type: "function", name: "save_memories", strict: true });
  expect(s.requests[0]?.turns[0]?.text).toContain("User: 나 커피 좋아해");

  expect(await s.memory.extractNow(s.roomId)).toEqual({ saved: 0, superseded: 0, skipped: "nothing_new" });
  expect(s.requests).toHaveLength(1);
});

test("격리 에이전트: 공용을 요청해도 자기 범위에만 쓰고, 공용 기억을 대체하지 못한다", async () => {
  let sharedId = "";
  const s = setup(() => save([mem("이제 차를 좋아한다", { replaces: [sharedId] })]), true);
  sharedId = s.store.create({
    scope: SHARED_SCOPE,
    kind: "preference",
    content: "커피를 좋아한다",
    contentEn: "",
    importance: 5,
    validUntil: null,
  }).id;
  s.say("user", "요즘은 커피 말고 차가 좋아");
  expect(await s.memory.extractNow(s.roomId)).toEqual({ saved: 1, superseded: 0, skipped: "" });
  expect(s.store.get(sharedId)?.supersededBy).toBeNull();
  expect(s.store.list().find((m) => m.content.startsWith("이제"))?.scope).toBe(s.agent.id);
  // 기존 공용 기억은 모델에 보여 주었다 (읽기는 가능)
  expect(s.requests[0]?.turns[0]?.text).toContain(`id=${sharedId} [shared]`);
});

test("바뀐 선호는 이전 기억을 대체하고, 같은 내용은 새로 만들지 않는다", async () => {
  let oldId = "";
  const s = setup(() =>
    save([mem("이제 차를 좋아한다", { replaces: [oldId, "모르는-id"] }), mem("커피를 좋아한다", { importance: 5 })]),
  );
  oldId = s.store.create({
    scope: SHARED_SCOPE,
    kind: "preference",
    content: "커피를 좋아한다",
    contentEn: "",
    importance: 2,
    validUntil: null,
  }).id;
  s.say("user", "커피 말고 이제 차가 좋아");
  expect(await s.memory.extractNow(s.roomId)).toEqual({ saved: 1, superseded: 1, skipped: "" });
  expect(s.store.get(oldId)?.supersededBy).not.toBeNull();
  expect(s.store.list().map((m) => m.content)).toEqual(["이제 차를 좋아한다"]);
});

test("실패하면 워터마크를 두고 다음에 다시, 잘못된 결과는 저장 없이 넘어간다", async () => {
  let mode: "fail" | "bad" | "ok" = "fail";
  const s = setup(() =>
    mode === "fail" ? { outcome: "failed" } : mode === "bad" ? save([{ kind: "nope" }]) : save([mem("기억")]),
  );
  s.say("user", "기억해줘");
  expect((await s.memory.extractNow(s.roomId)).skipped).toBe("x");
  mode = "bad";
  expect(await s.memory.extractNow(s.roomId)).toEqual({ saved: 0, superseded: 0, skipped: "" });
  mode = "ok";
  expect((await s.memory.extractNow(s.roomId)).skipped).toBe("nothing_new"); // 잘못된 결과도 처리 완료로 본다
});

test("대화가 길면 여러 묶음으로 나눠 추출한다", async () => {
  const s = setup(() => save([]), false, 30);
  for (let i = 0; i < 4; i++) s.say("user", `메시지 ${i} ${"가".repeat(20)}`);
  await s.memory.extractNow(s.roomId);
  expect(s.requests).toHaveLength(3); // maxChunks 3
  expect(s.requests[0]?.turns[0]?.text).toContain("메시지 0");
  expect(s.requests[0]?.turns[0]?.text).not.toContain("메시지 1");
  await s.memory.extractNow(s.roomId);
  expect(s.requests).toHaveLength(4); // 남은 하나
});

test("조용해지면 자동 추출 (새 메시지가 오면 타이머를 다시 건다)", async () => {
  const s = setup(() => save([mem("자동")]));
  s.say("user", "안녕");
  s.memory.noteActivity(s.roomId);
  await Bun.sleep(10);
  s.memory.noteActivity(s.roomId);
  expect(s.requests).toHaveLength(0);
  await Bun.sleep(60);
  expect(s.requests).toHaveLength(1);
  expect(s.store.list().map((m) => m.content)).toEqual(["자동"]);
});

test("자동 추출에 동의하지 않으면 자동으로는 호출하지 않고, 직접 누르면 추출한다", async () => {
  const s = setup(() => save([mem("수동")]));
  s.memory.autoExtract = () => false;
  s.say("user", "안녕");
  s.memory.noteActivity(s.roomId);
  await Bun.sleep(60);
  expect(s.requests).toHaveLength(0);
  expect(await s.memory.extractNow(s.roomId, false)).toMatchObject({ skipped: "consent" });
  expect(s.requests).toHaveLength(0);
  s.memory.scheduleNormalize(0);
  await Bun.sleep(10);
  expect(s.requests).toHaveLength(0);

  await s.memory.extractNow(s.roomId);
  expect(s.requests).toHaveLength(1);
  expect(s.store.list().map((m) => m.content)).toEqual(["수동"]);
});

test("영어 정규화와 요청 주입", async () => {
  const s = setup((req) => {
    const ids = [...(req.turns[0]?.text ?? "").matchAll(/id=([0-9a-f-]{36})/g)].map((m) => m[1]);
    return { call: { name: "set_translations", args: { items: ids.map((id) => ({ id, content_en: `EN ${id}` })) } } };
  });
  const a = s.store.create({
    scope: SHARED_SCOPE,
    kind: "fact",
    content: "민지는 동생",
    contentEn: "",
    importance: 5,
    validUntil: null,
  });
  s.store.create({
    scope: SHARED_SCOPE,
    kind: "fact",
    content: "고양이를 키운다",
    contentEn: "Has a cat",
    importance: 2,
    validUntil: null,
  });
  s.store.create({
    scope: "other-agent",
    kind: "fact",
    content: "다른 에이전트 고양이",
    contentEn: "",
    importance: 5,
    validUntil: null,
  });
  expect(await s.memory.normalizeStale()).toBe(2); // 영어본이 없는 활성 기억 (범위 무관)
  expect(s.store.get(a.id)?.contentEn).toBe(`EN ${a.id}`);

  const used = await s.memory.forTurn(s.agent, "고양이 이름 기억나?");
  expect(used.map((m) => m.content).sort()).toEqual(["고양이를 키운다", "민지는 동생"]); // 핵심 + 검색, 다른 에이전트 범위 제외
  expect(s.store.get(a.id)?.lastUsedAt).not.toBeNull();
});

test("재시작 후 미처리 대화가 있는 방을 다시 예약한다", async () => {
  const s = setup(() => save([mem("재시작 전 대화")]));
  s.say("user", "재시작 전에 한 말");
  s.memory.resumePending();
  await Bun.sleep(60);
  expect(s.store.list().map((m) => m.content)).toEqual(["재시작 전 대화"]);
  s.memory.resumePending(); // 이제 처리할 것이 없다
  await Bun.sleep(40);
  expect(s.requests).toHaveLength(1);
});

test("전역 모델 설정이 비어 있으면 그 방에서 실제로 쓴 모델로 추출한다", async () => {
  const s = setup(() => save([]), false, DEFAULT_MEMORY_OPTIONS.chunkChars, "");
  s.say("user", "안녕");
  expect((await s.memory.extractNow(s.roomId)).skipped).toBe("no_model"); // 쓴 모델이 없으면 건너뛴다
  s.db.query("UPDATE messages SET model = 'used-model'").run();
  s.say("user", "다시 안녕");
  await s.memory.extractNow(s.roomId);
  expect(s.requests.at(-1)?.model).toBe("used-model");
});

test("과거 대화(백로그)는 자동 추출에서 빠지고, 수동 추출에서만 처리한다", async () => {
  const s = setup((req) => save([mem(`m${req.turns[0]?.text.includes("과거") ? "과거" : "새"}`)]));
  s.say("user", "과거 대화 하나");
  s.say("assistant", "과거 답변");
  const until = (s.db.query("SELECT MAX(created_at) t FROM messages").get() as { t: number }).t;
  s.db.query("INSERT INTO memory_backlog (room_id, until) VALUES (?, ?)").run(s.roomId, until);
  s.say("user", "새 대화");

  expect(await s.memory.extractNow(s.roomId, false)).toMatchObject({ saved: 1 }); // 자동: 새 대화만
  expect(s.requests[0]?.turns[0]?.text).not.toContain("과거 대화 하나");
  expect(await s.memory.extractNow(s.roomId, false)).toMatchObject({ skipped: "nothing_new" });

  s.memory.resumePending();
  await Bun.sleep(60);
  expect(s.requests).toHaveLength(1); // 재시작해도 과거 대화를 훑지 않는다

  expect(await s.memory.extractNow(s.roomId)).toMatchObject({ saved: 1 }); // 수동: 과거 대화
  expect(s.requests[1]?.turns[0]?.text).toContain("과거 대화 하나");
  expect(s.requests[1]?.turns[0]?.text).not.toContain("User: 새 대화");
  expect(s.db.query("SELECT COUNT(*) n FROM memory_backlog").get()).toEqual({ n: 0 });
  expect(await s.memory.extractNow(s.roomId)).toMatchObject({ skipped: "nothing_new" });
});

// ---- 기억 관리 (P10e) ----

const messageIds = (s: ReturnType<typeof setup>) =>
  s.db
    .query<{ id: string }, []>("SELECT id FROM messages ORDER BY created_at")
    .all()
    .map((r) => r.id);

test("출처 메시지: 모델이 가리킨 [번호], 없거나 범위 밖이면 그 묶음의 마지막 메시지", async () => {
  const s = setup(() =>
    save([
      mem("커피를 좋아한다", { from: 1 }),
      mem("고양이를 키운다", { from: null }),
      mem("서울에 산다", { from: 99 }),
      mem("녹차도 좋아한다"), // from 이 없는 예전 형식
    ]),
  );
  s.say("user", "나 커피 좋아해");
  s.say("assistant", "좋네요");
  s.say("user", "고양이도 키워");
  await s.memory.extractNow(s.roomId);
  const [first, , last] = messageIds(s);
  const src = (c: string) => s.store.list().find((m) => m.content === c)?.sourceMessageId;
  expect(src("커피를 좋아한다")).toBe(first);
  expect(src("고양이를 키운다")).toBe(last);
  expect(src("서울에 산다")).toBe(last);
  expect(src("녹차도 좋아한다")).toBe(last);
  expect(s.requests[0]?.turns[0]?.text).toContain("[1] User: 나 커피 좋아해");
  expect(s.requests[0]?.tools?.[0]).toMatchObject({
    parameters: { properties: { memories: { items: { required: expect.arrayContaining(["from"]) } } } },
  });
});

test("참고한 답변: 그 기억을 넣은 답변만 최신순, 방 제목·발췌, 기억마다 수", () => {
  const s = setup(() => ({}));
  const a = s.store.create({
    scope: SHARED_SCOPE,
    kind: "fact",
    content: "가",
    contentEn: "",
    importance: 3,
    validUntil: null,
  });
  const b = s.store.create({
    scope: SHARED_SCOPE,
    kind: "fact",
    content: "나",
    contentEn: "",
    importance: 3,
    validUntil: null,
  });
  const put = (ids: string[], content: string, at: number) =>
    s.db
      .query(
        `INSERT INTO messages (id, room_id, role, agent_id, content, status, created_at, memory_ids)
         VALUES (?, ?, 'assistant', ?, ?, 'complete', ?, ?)`,
      )
      .run(crypto.randomUUID(), s.roomId, s.agent.id, content, at, JSON.stringify(ids));
  put([a.id], "첫 답", 10);
  put([a.id, b.id], "둘째 답", 20);
  put([b.id], "셋째 답", 30);
  const uses = s.store.uses(a.id, 50);
  expect(uses.total).toBe(2);
  expect(uses.items.map((u) => [u.excerpt, u.roomTitle, u.agentId])).toEqual([
    ["둘째 답", "t", s.agent.id],
    ["첫 답", "t", s.agent.id],
  ]);
  expect(s.store.uses(a.id, 1).items).toHaveLength(1);
  expect(s.memory.useCounts()).toEqual({ [a.id]: 2, [b.id]: 2 });
});

test("일괄 바꾸기·지우기와 병합 (원본은 대체됨, 출처는 같을 때만)", () => {
  const changes: number[] = [];
  const s = setup(() => ({}));
  const store = new MemoryStore(s.db, () => changes.push(1));
  const input = (content: string) => ({
    scope: SHARED_SCOPE,
    kind: "fact" as const,
    content,
    contentEn: "",
    importance: 3,
    validUntil: null,
  });
  const x = store.create(input("x"), s.roomId, true, "m1");
  const y = store.create(input("y"), s.roomId, true, "m2");
  const z = store.create(input("z"), "other", true, "m3");

  expect(store.bulk({ ids: [x.id, y.id], set: { kind: "preference", importance: 5 }, delete: false })).toBe(2);
  expect(store.get(x.id)).toMatchObject({ kind: "preference", importance: 5, scope: SHARED_SCOPE });
  expect(changes).toHaveLength(1); // 한 번만 알린다

  const merged = store.merge([x.id, y.id], input("x 와 y"));
  expect(merged).toMatchObject({ content: "x 와 y", sourceRoomId: s.roomId, sourceMessageId: "" });
  expect(store.get(x.id)?.supersededBy).toBe(merged?.id);
  expect(store.get(y.id)?.supersededBy).toBe(merged?.id);
  expect(
    store
      .list()
      .map((m) => m.content)
      .sort(),
  ).toEqual(["x 와 y", "z"]);
  expect(store.merge([z.id, "missing"], input("?"))).toBeNull();
  expect(store.merge([merged?.id ?? "", z.id], input("모두"))?.sourceRoomId).toBe("");

  expect(store.bulk({ ids: [z.id], delete: true })).toBe(1);
  expect(store.get(z.id)).toBeNull();
});

test("그래프: 임베딩이 꺼져 있으면 키워드 유사도, 함께 쓰인 기억은 2번 이상·'거의 전부 넣은 답변' 제외", () => {
  const s = setup(() => ({}));
  const make = (content: string) =>
    s.store.create({ scope: SHARED_SCOPE, kind: "fact", content, contentEn: "", importance: 3, validUntil: null });
  const ms = [
    make("커피를 좋아한다"),
    make("아침마다 커피를 마신다"),
    make("고양이를 키운다"),
    make("고양이 이름은 나비"),
    make("서울에 산다"),
    make("자전거를 탄다"),
  ];
  const [coffee1, coffee2, cat1, cat2, seoul, bike] = ms.map((m) => m.id) as string[];
  let t = 100;
  const put = (ids: string[]) =>
    s.db
      .query(
        `INSERT INTO messages (id, room_id, role, agent_id, content, status, created_at, memory_ids)
         VALUES (?, ?, 'assistant', ?, 'a', 'complete', ?, ?)`,
      )
      .run(crypto.randomUUID(), s.roomId, s.agent.id, ++t, JSON.stringify(ids));
  put([seoul as string, bike as string]);
  put([seoul as string, bike as string]);
  put([cat1 as string, seoul as string]); // 한 번뿐 → 간선 없음
  put(ms.map((m) => m.id)); // 전부 넣은 답변 → 세지 않음
  put(ms.map((m) => m.id));

  const g = s.memory.graph();
  expect(g.similarity).toBe("keyword");
  const has = (kind: string, a?: string, b?: string) =>
    g.edges.some((e) => e.kind === kind && ((e.a === a && e.b === b) || (e.a === b && e.b === a)));
  expect(has("similar", coffee1, coffee2)).toBe(true);
  expect(has("similar", cat1, cat2)).toBe(true);
  expect(g.edges.filter((e) => e.kind === "co_used")).toEqual([
    { a: expect.any(String), b: expect.any(String), kind: "co_used", weight: 2 },
  ]);
  expect(has("co_used", seoul, bike)).toBe(true);
  // 같은 쌍은 한 번만
  const keys = g.edges.map((e) => `${e.kind}|${[e.a, e.b].sort().join("|")}`);
  expect(new Set(keys).size).toBe(keys.length);
});

test("추출: 도중에 실패해도 앞 묶음까지 알리고 임베딩 색인을 건다", async () => {
  let n = 0;
  const s = setup(() => (++n === 1 ? save([mem("첫 묶음에서 나온 기억")]) : { outcome: "failed" }), false, 10);
  let indexed = 0;
  s.memory.vectors = { schedule: async () => void indexed++ } as unknown as NonNullable<typeof s.memory.vectors>;
  s.say("user", "첫 묶음의 긴 메시지입니다");
  s.say("user", "둘째 묶음의 긴 메시지입니다");
  const r = await s.memory.extractNow(s.roomId);
  expect(r).toMatchObject({ saved: 1, skipped: "x" });
  expect(s.events).toEqual(["memories"]);
  expect(indexed).toBe(1);
});
