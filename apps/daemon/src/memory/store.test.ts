import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type MemoryInput, SHARED_SCOPE } from "@proprix/shared";
import { migrate } from "../storage/db";
import { MemoryStore, queryTerms } from "./store";

function setup() {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  const store = new MemoryStore(db);
  const add = (content: string, patch: Partial<MemoryInput> = {}) =>
    store.create({
      scope: SHARED_SCOPE,
      kind: "fact",
      content,
      contentEn: "",
      importance: 3,
      validUntil: null,
      ...patch,
    });
  return { db, store, add };
}

const texts = (ms: { content: string }[]) => ms.map((m) => m.content);

test("검색어 분해: 한 글자 제거, 중복 제거", () => {
  expect(queryTerms("나는 커피를 좋아해, 커피를!")).toEqual(["나는", "커피를", "좋아해"]);
  expect(queryTerms("a b")).toEqual([]);
});

test("한국어: 조사가 붙은 질의·저장 모두 찾는다", () => {
  const { store, add } = setup();
  add("나는 커피를 좋아한다", { contentEn: "Likes coffee" });
  add("여동생 이름은 민지", { contentEn: "Younger sister is 민지 (Minji)" });
  add("주말에는 등산을 간다");
  const s = (q: string) => texts(store.search(q, [SHARED_SCOPE], 5));
  expect(s("커피")).toContain("나는 커피를 좋아한다"); // 2자: 부분 일치
  expect(s("커피는 어때")).toContain("나는 커피를 좋아한다"); // 조사 뗀 접두 "커피*"
  expect(s("여동생이 누구야")).toContain("여동생 이름은 민지"); // trigram "여동생"
  expect(s("동생")).toContain("여동생 이름은 민지"); // 2자 부분 일치 (접두 아님)
  expect(s("coffee")).toContain("나는 커피를 좋아한다"); // 영어본
  expect(s("Minji")).toContain("여동생 이름은 민지");
  expect(s("등산")[0]).toBe("주말에는 등산을 간다");
  expect(s('"; DROP TABLE memories; --')).toEqual([]); // 따옴표·기호는 검색어에서 빠진다
});

test("범위·대체·만료는 검색과 핵심 기억에서 빠진다", () => {
  const { store, add } = setup();
  add("공용 커피 기억");
  add("에이전트 커피 기억", { scope: "agent-1" });
  const old = add("예전 커피 기억", { importance: 5 });
  const neu = add("새 커피 기억", { importance: 5 });
  store.supersede(old.id, neu.id);
  add("지난 커피 일정", { validUntil: Date.now() - 1 });
  expect(texts(store.search("커피", [SHARED_SCOPE], 10)).sort()).toEqual(["공용 커피 기억", "새 커피 기억"].sort());
  expect(texts(store.search("커피", [SHARED_SCOPE, "agent-1"], 10))).toContain("에이전트 커피 기억");
  expect(texts(store.core([SHARED_SCOPE], 5))).toEqual(["새 커피 기억"]);
  expect(store.list({ history: true })).toHaveLength(5);
  expect(store.list()).toHaveLength(4); // 대체된 것만 빠짐 (만료는 관리 화면에 남김)
});

test("중복 판정은 대소문자·문장부호를 무시하고 같은 범위에서만", () => {
  const { store, add } = setup();
  add("커피를 좋아한다.", { contentEn: "Likes coffee." });
  expect(store.findDuplicate(SHARED_SCOPE, "커피를 좋아한다", "")).not.toBeNull();
  expect(store.findDuplicate(SHARED_SCOPE, "다른 말", "likes coffee")).not.toBeNull();
  expect(store.findDuplicate("agent-1", "커피를 좋아한다", "")).toBeNull();
});

test("원문을 고치면 영어본을 비워 다시 정규화 대상이 된다", () => {
  const { store, add } = setup();
  const m = add("커피를 좋아한다", { contentEn: "Likes coffee" });
  store.update(m.id, { ...m, content: "차를 좋아한다" });
  expect(store.get(m.id)?.contentEn).toBe("");
  expect(store.staleEnglish(10).map((x) => x.id)).toEqual([m.id]);
  expect(texts(store.search("차를", [SHARED_SCOPE], 5))).toEqual(["차를 좋아한다"]); // 색인도 갱신
  expect(store.search("coffee", [SHARED_SCOPE], 5)).toEqual([]);
});
