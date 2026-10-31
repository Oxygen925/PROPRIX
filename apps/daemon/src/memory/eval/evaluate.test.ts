import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { queryTerms } from "../store";
import { EvalDataset, evaluate, toMarkdown, VARIANTS, type VectorSet, vectorVariants } from "./evaluate";

const tiny = EvalDataset.parse({
  memories: [
    { key: "a", kind: "preference", content: "커피를 좋아한다", contentEn: "Likes coffee", supersededBy: "b" },
    { key: "b", kind: "preference", content: "요즘은 녹차를 마신다", contentEn: "Drinks green tea these days" },
    { key: "c", kind: "event", content: "치과 예약", contentEn: "Dentist appointment", expired: true },
  ],
  queries: [
    { type: "changed", q: "녹차", qEn: "green tea", expect: ["b"], forbid: ["a"] },
    { type: "past", q: "치과 예약", qEn: "dentist", expect: [], forbid: ["c"] },
    { type: "keyword", q: "없는 말", qEn: "nothing", expect: ["b"] },
  ],
});

test("지표: 재현율·적중·빈 결과·금지 기억, 대체·만료는 결과에 없다", () => {
  const [r] = evaluate(
    tiny,
    VARIANTS.filter((v) => v.name.startsWith("hybrid (")),
    5,
    1,
  );
  expect(r?.overall).toMatchObject({ recall: 0.5, hit: 0.5, wrong: 0, empty: 0.5, queries: 3 });
  expect(r?.byType.changed.recall).toBe(1);
  expect(r?.misses.map((m) => m.q)).toEqual(["없는 말"]);
});

test("평가셋의 key 오류는 바로 알려 준다", () => {
  const bad = EvalDataset.parse({ ...tiny, queries: [{ type: "keyword", q: "x", expect: ["zz"] }] });
  expect(() => evaluate(bad)).toThrow("zz");
});

test("합성 예시셋은 형식이 맞고 모든 변형이 돈다", () => {
  const ds = EvalDataset.parse(JSON.parse(readFileSync(join(import.meta.dir, "data", "example.json"), "utf8")));
  expect(ds.queries.length).toBeGreaterThanOrEqual(50);
  const results = evaluate(ds, VARIANTS, 5, 1);
  expect(results).toHaveLength(VARIANTS.length);
  for (const r of results) expect(r.overall.wrong).toBe(0); // 대체·만료 기억은 어떤 변형에서도 나오지 않는다
  expect(toMarkdown(ds, results, 5)).toContain("| hybrid (운영 기본) |");
});

test("영어 불용어는 검색어에서 빠진다", () => {
  expect(queryTerms("What do I like these days?")).toEqual(["like", "days"]);
});

test("벡터 변형: 대체·만료 기억은 후보에서 빠지고, z 기준은 동떨어진 결과만 남긴다 (모델 없이 가짜 벡터)", () => {
  const v = (...xs: number[]) => {
    const n = Math.hypot(...xs) || 1;
    return new Float32Array(xs.map((x) => x / n));
  };
  // 질문 "녹차" 는 b(현재 선호)와 a(대체된 옛 선호) 둘 다에 가깝다 — a 는 나오면 안 된다
  const vectors: VectorSet[] = [
    {
      model: "fake",
      docs: new Map([
        ["a", v(1, 0.1, 0)],
        ["b", v(0.9, 0.2, 0)],
        ["c", v(0.8, 0.3, 0)],
      ]),
      queries: new Map([
        ["녹차", { vec: v(1, 0.1, 0), ms: 1 }],
        ["치과 예약", { vec: v(0, 0, 1), ms: 1 }],
        ["없는 말", { vec: v(0, 1, 0), ms: 1 }],
      ]),
    },
  ];
  const results = evaluate(tiny, vectorVariants(["fake"]), 5, 1, vectors);
  const plain = results.find((r) => r.variant.name === "fake · 벡터");
  expect(plain?.overall.wrong).toBe(0);
  expect(plain?.byType.changed.recall).toBe(1);
  expect(plain?.overall.p50).toBeGreaterThanOrEqual(1); // 질문 임베딩 시간 포함
  // 모델 벡터가 없으면 그 변형은 건너뛴다
  expect(evaluate(tiny, vectorVariants(["missing"]), 5, 1, vectors)).toEqual([]);
});
