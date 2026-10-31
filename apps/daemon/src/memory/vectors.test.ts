// 로컬 임베딩 색인 (가짜 임베딩): 상태·색인·내용 변경 재계산·z 컷 검색·실패 시 키워드만·주입 보강
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Agent, type EmbeddingStatus, SHARED_SCOPE } from "@proprix/shared";
import { AgentStore, DEFAULT_AGENT_ID } from "../agents/store";
import { LlmGate } from "../llm/gate";
import { migrate } from "../storage/db";
import { DEFAULT_MEMORY_OPTIONS, MemoryService } from "./service";
import { MemoryStore } from "./store";
import { type EmbedFns, VectorIndex } from "./vectors";

// 낱말 → 개념 축. 키워드가 겹치지 않아도 같은 개념이면 가깝게 나온다
const CONCEPTS = [
  ["고양이", "반려", "강아지", "냥"],
  ["커피", "녹차", "음료", "마실"],
  ["동생", "엄마", "가족", "언니"],
  ["헬스", "운동", "축구"],
  ["회사", "업무", "출근"],
  ["김밥", "음식", "먹"],
  ["여행", "제주"],
  ["음악", "노래"],
];

function fakeVec(text: string): Float32Array {
  const v = new Float32Array(CONCEPTS.length + 1).fill(0);
  CONCEPTS.forEach((words, i) => {
    for (const w of words) if (text.includes(w)) v[i] = (v[i] ?? 0) + 1;
  });
  v[CONCEPTS.length] = 0.05; // 아무 개념도 없을 때 0 벡터가 되지 않게
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / norm);
}

const fake = (calls: string[][] = []): EmbedFns => ({
  async embedQueries(texts) {
    return texts.map(fakeVec);
  },
  async embedDocs(texts) {
    calls.push(texts);
    return texts.map(fakeVec);
  },
});

function setup() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON"); // 운영(openDb)과 같이: 기억을 지우면 벡터도 지워진다
  migrate(db);
  const statuses: EmbeddingStatus[] = [];
  const docCalls: string[][] = [];
  let failLoad = false;
  const vectors = new VectorIndex(
    db,
    async (m) => {
      if (failLoad) throw new Error("load failed");
      expect(m.id).toBeOneOf(["embeddinggemma", "e5-small"]);
      return fake(docCalls);
    },
    (s) => statuses.push(s),
  );
  const store = new MemoryStore(db, () => void vectors.schedule());
  const add = (content: string, importance = 3) =>
    store.create({ scope: SHARED_SCOPE, kind: "fact", content, contentEn: "", importance, validUntil: null });
  return {
    db,
    store,
    vectors,
    statuses,
    docCalls,
    add,
    failLoad: (v: boolean) => {
      failLoad = v;
    },
  };
}

const MEMORIES = [
  "고양이를 키운다",
  "아침마다 커피를 마신다",
  "동생 이름은 민지",
  "주말에 헬스장에 간다",
  "회사는 판교에 있다",
  "김밥을 좋아한다",
  "제주 여행을 계획 중",
  "노래방을 즐긴다",
];

test("켜면 불러와 기존 기억을 색인하고, 내용이 바뀌면 다시 계산하며, 끄면 검색하지 않는다", async () => {
  const s = setup();
  for (const m of MEMORIES) s.add(m);
  expect(s.vectors.status()).toMatchObject({ model: "off", state: "off", indexed: 0, total: 8 });
  expect(await s.vectors.search("반려동물", [SHARED_SCOPE], 5)).toEqual([]);

  await s.vectors.configure("embeddinggemma");
  await s.vectors.schedule();
  expect(s.statuses.map((x) => x.state)).toContain("loading");
  expect(s.vectors.status()).toMatchObject({ state: "ready", indexed: 8, total: 8 });

  // 키워드가 겹치지 않는 질문도 개념이 같으면 찾는다 (평균 + 2σ 이상만)
  const hit = await s.vectors.search("반려동물 이름이 뭐였지", [SHARED_SCOPE], 5);
  expect(hit.map((id) => s.store.get(id)?.content)).toEqual(["고양이를 키운다"]);
  expect(await s.vectors.search("오늘 날씨", [SHARED_SCOPE], 5)).toEqual([]); // 두드러진 것이 없으면 없음
  expect(await s.vectors.search("반려동물", ["other-scope"], 5)).toEqual([]);

  // 새 기억·내용 변경만 다시 계산
  s.docCalls.length = 0;
  const added = s.add("강아지도 키우고 싶다");
  await s.vectors.schedule();
  expect(s.docCalls.flat()).toEqual(["강아지도 키우고 싶다"]);
  s.store.update(added.id, {
    scope: SHARED_SCOPE,
    kind: "fact",
    content: "엄마가 강아지를 키운다",
    contentEn: "",
    importance: 3,
    validUntil: null,
  });
  await s.vectors.schedule();
  expect(s.docCalls.flat()).toEqual(["강아지도 키우고 싶다", "엄마가 강아지를 키운다"]);
  s.store.delete(added.id);
  expect(s.db.query("SELECT COUNT(*) AS n FROM memory_embeddings").get()).toEqual({ n: 8 });

  // 다른 모델로 바꾸면 전부 다시 계산
  s.docCalls.length = 0;
  await s.vectors.configure("e5-small");
  await s.vectors.schedule();
  expect(s.docCalls.flat()).toHaveLength(8);
  expect(s.vectors.status()).toMatchObject({ model: "e5-small", indexed: 8 });

  await s.vectors.configure("off");
  expect(s.vectors.status()).toMatchObject({ state: "off", indexed: 0 });
  expect(await s.vectors.search("반려동물", [SHARED_SCOPE], 5)).toEqual([]);
});

test("불러오기에 실패하면 failed 상태로 키워드 검색만 쓰고, 다시 켜면 재시도한다", async () => {
  const s = setup();
  s.failLoad(true);
  await s.vectors.configure("embeddinggemma");
  expect(s.vectors.status()).toMatchObject({ state: "failed", error: "load failed" });
  expect(await s.vectors.search("반려동물", [SHARED_SCOPE], 5)).toEqual([]);
  s.failLoad(false);
  await s.vectors.configure("embeddinggemma");
  expect(s.vectors.status().state).toBe("ready");
});

test("주입: 기억이 상한 이하면 전부, 많으면 핵심 → 하이브리드 검색 → 중요도·최근 순으로 채운다", async () => {
  const s = setup();
  const db = s.db;
  const agents = new AgentStore(db);
  const gate = new LlmGate(db, () => {});
  const llm = { stream: async () => ({}) as never };
  const memory = new MemoryService(
    db,
    s.store,
    llm,
    gate,
    agents,
    () => "m",
    () => {},
    {
      ...DEFAULT_MEMORY_OPTIONS,
      injectLimit: 3,
      coreLimit: 1,
      idleMs: 60 * 60_000,
    },
  );
  memory.vectors = s.vectors;
  const agent = agents.agent(DEFAULT_AGENT_ID) as Agent;

  s.add("고양이를 키운다");
  s.add("아침마다 커피를 마신다");
  expect((await memory.forTurn(agent, "아무거나")).map((m) => m.content).sort()).toEqual([
    "고양이를 키운다",
    "아침마다 커피를 마신다",
  ]);

  for (const m of MEMORIES.slice(2)) s.add(m);
  s.add("가족 모두 서울에 산다", 5); // 핵심 기억
  // 임베딩 꺼짐: 키워드로 못 찾는 질문은 핵심 + 중요도·최근 순으로만
  let got = (await memory.forTurn(agent, "반려동물 이름이 뭐였지")).map((m) => m.content);
  expect(got).toHaveLength(3);
  expect(got[0]).toBe("가족 모두 서울에 산다");
  // 키워드 검색만으로는 찾지 못한다 (채우기는 같은 시각에 만든 기억끼리 순서가 정해지지 않아 보지 않음)
  expect((await memory.search("반려동물", [SHARED_SCOPE], 3)).map((m) => m.content)).toEqual([]);

  await s.vectors.configure("embeddinggemma");
  await s.vectors.schedule();
  got = (await memory.forTurn(agent, "반려동물 이름이 뭐였지")).map((m) => m.content);
  expect(got[0]).toBe("가족 모두 서울에 산다");
  expect(got).toContain("고양이를 키운다"); // 키워드("이름")로 걸린 "동생 이름은 민지" 와 함께
  expect(got).toHaveLength(3);
  // memory_search 와 같은 하이브리드 검색
  expect((await memory.search("반려동물", [SHARED_SCOPE], 2)).map((m) => m.content)).toEqual(["고양이를 키운다"]);
});
