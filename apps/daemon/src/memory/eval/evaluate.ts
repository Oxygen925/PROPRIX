// 메모리 검색 평가: 평가셋(기억 + 질문)을 메모리 DB 에 올려 검색 변형별로 지표를 잰다.
// 지표 정의 (top-K = 5):
//   Recall@K   질문마다 기대 기억 중 top-K 에 든 비율의 평균 (기대 기억이 없는 질문은 제외)
//   Hit@K      기대 기억이 하나라도 top-K 에 든 질문 비율
//   잘못된 기억  금지 기억(대체·만료된 옛 정보)이 top-K 에 들어온 질문 비율
//   무관 비율    top-K 결과 중 기대·허용 목록에 없는 것의 비율 (결과가 있는 질문만)
//   빈 결과      아무것도 못 찾은 질문 비율 (기대 기억이 있는 질문만)
//   지연         검색 1회 시간 p50·p95 (ms)
import { Database } from "bun:sqlite";
import { SHARED_SCOPE } from "@proprix/shared";
import { z } from "zod";
import { migrate } from "../../storage/db";
import { MemoryStore, rrf, type SearchOptions } from "../store";

export const QUERY_TYPES = ["keyword", "paraphrase", "past", "changed"] as const;

export const EvalDataset = z.object({
  description: z.string().default(""),
  memories: z.array(
    z.object({
      key: z.string(),
      kind: z.enum(["fact", "preference", "event", "relationship"]),
      content: z.string(),
      contentEn: z.string().default(""),
      importance: z.number().int().min(1).max(5).default(3),
      supersededBy: z.string().nullable().default(null), // 다른 기억의 key
      expired: z.boolean().default(false), // 유효 기간이 지난 기억
    }),
  ),
  queries: z.array(
    z.object({
      q: z.string(),
      qEn: z.string().default(""), // 질문의 영어 번역 (번역 변형용 — 미리 넣어 두면 평가에 LLM 호출이 없다)
      type: z.enum(QUERY_TYPES),
      expect: z.array(z.string()), // 찾아야 하는 기억 key
      allow: z.array(z.string()).default([]), // 나와도 무관하지 않은 기억 key
      forbid: z.array(z.string()).default([]), // 나오면 안 되는 기억 key (옛 정보)
    }),
  ),
});
export type EvalDataset = z.infer<typeof EvalDataset>;

type Query = EvalDataset["queries"][number];

// 임베딩 변형용: 미리 계산한 벡터 (기억은 key, 질문은 질문 문장으로 찾는다)
export interface VectorSet {
  model: string;
  docs: Map<string, Float32Array>; // 기억 key → 벡터
  queries: Map<string, { vec: Float32Array; ms: number }>; // 질문 → 벡터·임베딩 시간
}

export interface EvalContext {
  vectors: Map<string, { docs: Map<string, Float32Array>; queries: VectorSet["queries"] }>; // 기억 id 기준
}

export interface Variant {
  name: string;
  description: string;
  needs?: string; // 필요한 임베딩 모델 id (없으면 건너뜀)
  // 질문 → 순위 목록. ko·en 검색을 합치는 변형도 있어 함수로 둔다
  run(store: MemoryStore, q: Query, k: number, ctx: EvalContext): string[];
  extraMs?(q: Query, ctx: EvalContext): number; // 검색 외에 드는 시간 (질문 임베딩)
}

const scopes = [SHARED_SCOPE];
const ko = (opt: SearchOptions) => (store: MemoryStore, q: { q: string }, k: number) =>
  store.searchIds(q.q, scopes, k, opt);
const en = (opt: SearchOptions) => (store: MemoryStore, q: { q: string; qEn: string }, k: number) =>
  q.qEn ? store.searchIds(q.qEn, scopes, k, opt) : [];

export const VARIANTS: Variant[] = [
  { name: "unicode61", description: "접두 검색만 (원문+영어본)", run: ko({ signals: ["prefix"] }) },
  { name: "trigram", description: "trigram 만 (원문+영어본)", run: ko({ signals: ["trigram"] }) },
  { name: "unicode61+trigram", description: "접두 + trigram", run: ko({ signals: ["prefix", "trigram"] }) },
  { name: "hybrid (운영 기본)", description: "접두 + trigram + 2자 부분 일치", run: ko({}) },
  { name: "hybrid · 원문만", description: "운영 기본을 원문 필드에만", run: ko({ field: "content" }) },
  {
    name: "hybrid · 영어본만",
    description: "운영 기본을 영어본 필드에만 (한국어 질문)",
    run: ko({ field: "content_en" }),
  },
  {
    name: "번역 · 영어본",
    description: "질문을 영어로 번역해 영어본만 검색",
    run: en({ field: "content_en", signals: ["prefix", "trigram"] }),
  },
  {
    name: "hybrid + 번역",
    description: "운영 기본(한국어 질문)과 번역 검색을 RRF 로 합침",
    run: (store, q, k) => rrf([ko({})(store, q, k * 2), en({ field: "content_en" })(store, q, k * 2)]).slice(0, k),
  },
];

// 벡터 검색: 활성 기억 전체와 코사인 비교 (개인 규모라 전수 검색). zCut 이 있으면 점수가 평균+z·표준편차 이상인 것만
function vectorSearch(store: MemoryStore, ctx: EvalContext, model: string, q: Query, k: number, zCut?: number) {
  const v = ctx.vectors.get(model);
  const qv = v?.queries.get(q.q)?.vec;
  if (!v || !qv) return [];
  const scored = store
    .activeIds(scopes)
    .map((id) => {
      const d = v.docs.get(id);
      let s = 0;
      if (d) for (let i = 0; i < d.length; i++) s += (d[i] ?? 0) * (qv[i] ?? 0);
      return { id, s };
    })
    .sort((a, b) => b.s - a.s);
  if (zCut === undefined) return scored.slice(0, k).map((x) => x.id);
  const mean = scored.reduce((a, x) => a + x.s, 0) / (scored.length || 1);
  const std = Math.sqrt(scored.reduce((a, x) => a + (x.s - mean) ** 2, 0) / (scored.length || 1)) || 1;
  return scored
    .filter((x) => (x.s - mean) / std >= zCut)
    .slice(0, k)
    .map((x) => x.id);
}

export function vectorVariants(models: readonly string[]): Variant[] {
  return models.flatMap((m): Variant[] => {
    const extraMs = (q: Query, ctx: EvalContext) => ctx.vectors.get(m)?.queries.get(q.q)?.ms ?? 0;
    return [
      {
        name: `${m} · 벡터`,
        description: "벡터 검색만",
        needs: m,
        extraMs,
        run: (s, q, k, c) => vectorSearch(s, c, m, q, k),
      },
      {
        name: `${m} · 벡터 z≥1`,
        description: "벡터 검색, 점수가 평균+1σ 이상인 것만",
        needs: m,
        extraMs,
        run: (s, q, k, c) => vectorSearch(s, c, m, q, k, 1),
      },
      {
        name: `hybrid + ${m}`,
        description: "운영 기본 키워드 검색과 벡터 검색을 RRF 로",
        needs: m,
        extraMs,
        run: (s, q, k, c) => rrf([ko({})(s, q, k * 2), vectorSearch(s, c, m, q, k * 2)]).slice(0, k),
      },
      {
        name: `hybrid + ${m} z≥1`,
        description: "키워드 + 벡터(평균+1σ 이상)를 RRF 로",
        needs: m,
        extraMs,
        run: (s, q, k, c) => rrf([ko({})(s, q, k * 2), vectorSearch(s, c, m, q, k * 2, 1)]).slice(0, k),
      },
      {
        name: `hybrid + ${m} z≥1.5`,
        description: "키워드 + 벡터(평균+1.5σ 이상)를 RRF 로",
        needs: m,
        extraMs,
        run: (s, q, k, c) => rrf([ko({})(s, q, k * 2), vectorSearch(s, c, m, q, k * 2, 1.5)]).slice(0, k),
      },
      {
        name: `hybrid + ${m} z≥2`,
        description: "키워드 + 벡터(평균+2σ 이상)를 RRF 로",
        needs: m,
        extraMs,
        run: (s, q, k, c) => rrf([ko({})(s, q, k * 2), vectorSearch(s, c, m, q, k * 2, 2)]).slice(0, k),
      },
    ];
  });
}

export interface Metrics {
  recall: number;
  hit: number;
  wrong: number;
  noise: number;
  empty: number;
  p50: number;
  p95: number;
  queries: number;
}

export interface VariantResult {
  variant: Variant;
  overall: Metrics;
  byType: Record<(typeof QUERY_TYPES)[number], Metrics>;
  misses: { q: string; type: string; got: string[]; expect: string[] }[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

// 평가셋을 새 메모리 DB 에 올리고 key → id 대응을 돌려준다
export function loadDataset(ds: EvalDataset): {
  store: MemoryStore;
  idOf: Map<string, string>;
  keyOf: Map<string, string>;
} {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  const store = new MemoryStore(db);
  const idOf = new Map<string, string>();
  for (const m of ds.memories) {
    const created = store.create(
      {
        scope: SHARED_SCOPE,
        kind: m.kind,
        content: m.content,
        contentEn: m.contentEn,
        importance: m.importance,
        validUntil: m.expired ? Date.now() - 86_400_000 : null,
      },
      "",
      true,
    );
    idOf.set(m.key, created.id);
  }
  for (const m of ds.memories)
    if (m.supersededBy) {
      const by = idOf.get(m.supersededBy);
      if (!by) throw new Error(`supersededBy 가 없는 key: ${m.supersededBy}`);
      store.supersede(idOf.get(m.key) as string, by);
    }
  const keyOf = new Map([...idOf].map(([k, id]) => [id, k]));
  return { store, idOf, keyOf };
}

export function evaluate(
  ds: EvalDataset,
  variants: Variant[] = VARIANTS,
  k = 5,
  repeat = 5,
  vectors: readonly VectorSet[] = [],
): VariantResult[] {
  const keys = new Set(ds.memories.map((m) => m.key));
  for (const q of ds.queries)
    for (const key of [...q.expect, ...q.allow, ...q.forbid])
      if (!keys.has(key)) throw new Error(`질문 "${q.q}" 의 key 가 평가셋에 없음: ${key}`);

  const { store, keyOf, idOf } = loadDataset(ds);
  const ctx: EvalContext = { vectors: new Map() };
  for (const v of vectors)
    ctx.vectors.set(v.model, {
      docs: new Map([...v.docs].map(([key, vec]) => [idOf.get(key) ?? key, vec])),
      queries: v.queries,
    });
  const runnable = variants.filter((v) => !v.needs || ctx.vectors.has(v.needs));
  return runnable.map((variant) => {
    const rows = ds.queries.map((q) => {
      const times: number[] = [];
      let got: string[] = [];
      for (let i = 0; i < repeat; i++) {
        const t0 = performance.now();
        got = variant.run(store, q, k, ctx).map((id) => keyOf.get(id) ?? id);
        times.push(performance.now() - t0 + (variant.extraMs?.(q, ctx) ?? 0));
      }
      return { q, got, times };
    });

    const metrics = (subset: typeof rows): Metrics => {
      const withExpect = subset.filter((r) => r.q.expect.length > 0);
      const withResults = subset.filter((r) => r.got.length > 0);
      const times = subset.flatMap((r) => r.times).sort((a, b) => a - b);
      const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
      return {
        recall: avg(withExpect.map((r) => r.q.expect.filter((e) => r.got.includes(e)).length / r.q.expect.length)),
        hit: avg(withExpect.map((r) => (r.q.expect.some((e) => r.got.includes(e)) ? 1 : 0))),
        wrong: avg(subset.map((r) => (r.q.forbid.some((f) => r.got.includes(f)) ? 1 : 0))),
        noise: avg(
          withResults.map(
            (r) => r.got.filter((g) => !r.q.expect.includes(g) && !r.q.allow.includes(g)).length / r.got.length,
          ),
        ),
        empty: avg(withExpect.map((r) => (r.got.length === 0 ? 1 : 0))),
        p50: percentile(times, 50),
        p95: percentile(times, 95),
        queries: subset.length,
      };
    };

    return {
      variant,
      overall: metrics(rows),
      byType: Object.fromEntries(QUERY_TYPES.map((t) => [t, metrics(rows.filter((r) => r.q.type === t))])) as Record<
        (typeof QUERY_TYPES)[number],
        Metrics
      >,
      misses: rows
        .filter((r) => r.q.expect.length > 0 && !r.q.expect.some((e) => r.got.includes(e)))
        .map((r) => ({ q: r.q.q, type: r.q.type, got: r.got, expect: r.q.expect })),
    };
  });
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ms = (x: number) => x.toFixed(2);

export function toMarkdown(ds: EvalDataset, results: VariantResult[], k: number): string {
  const lines: string[] = [];
  lines.push(
    `평가셋: ${ds.description || "(설명 없음)"} — 기억 ${ds.memories.length}개, 질문 ${ds.queries.length}개, top-${k}`,
  );
  lines.push("");
  lines.push(`| 변형 | Recall@${k} | Hit@${k} | 잘못된 기억 | 무관 비율 | 빈 결과 | p50 ms | p95 ms |`);
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const m = r.overall;
    lines.push(
      `| ${r.variant.name} | ${pct(m.recall)} | ${pct(m.hit)} | ${pct(m.wrong)} | ${pct(m.noise)} | ${pct(m.empty)} | ${ms(m.p50)} | ${ms(m.p95)} |`,
    );
  }
  lines.push("");
  lines.push(`질문 유형별 Recall@${k}`);
  lines.push("");
  lines.push(`| 변형 | ${QUERY_TYPES.join(" | ")} |`);
  lines.push(`|---|${QUERY_TYPES.map(() => "---").join("|")}|`);
  for (const r of results)
    lines.push(
      `| ${r.variant.name} | ${QUERY_TYPES.map((t) => `${pct(r.byType[t].recall)} (${r.byType[t].queries})`).join(" | ")} |`,
    );
  return lines.join("\n");
}
