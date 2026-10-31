// 기억 그래프 (P10e)
import type { MemoryEdge, MemoryGraph } from "@proprix/shared";
import type { MemoryStore } from "./store";
import type { VectorIndex } from "./vectors";

// 기억마다 비슷한 기억 3개(평균 + 1.5σ 이상), 함께 쓰인 기억 5개(2번 이상)
const GRAPH_SIMILAR = 3;
const GRAPH_Z = 1.5;
const GRAPH_CO_USED = 5;
const GRAPH_CO_MIN = 2;

// 그래프 간선: 내용 유사도(임베딩이 켜져 있으면 코사인, 아니면 키워드 검색 순위) + 함께 쓰인 기억 (사용자 결정 2026-10-29)
export function memoryGraph(store: MemoryStore, vectors: VectorIndex | null): MemoryGraph {
  const active = store.list();
  const ids = active.map((m) => m.id);
  const edges: MemoryEdge[] = [];
  const seen = new Set<string>();
  const add = (a: string, b: string, kind: MemoryEdge["kind"], weight: number) => {
    const key = `${kind}|${a < b ? `${a}|${b}` : `${b}|${a}`}`;
    if (a === b || seen.has(key)) return;
    seen.add(key);
    edges.push({ a, b, kind, weight });
  };

  const pairs = vectors?.similarPairs(ids, GRAPH_SIMILAR, GRAPH_Z) ?? null;
  if (pairs) for (const p of pairs) add(p.a, p.b, "similar", Number(p.s.toFixed(3)));
  else {
    const scopes = [...new Set(active.map((m) => m.scope))];
    for (const m of active) {
      const near = store
        .searchIds(m.content, scopes, GRAPH_SIMILAR + 1)
        .filter((id) => id !== m.id)
        .slice(0, GRAPH_SIMILAR);
      for (const [rank, id] of near.entries()) add(m.id, id, "similar", 1 / (rank + 1));
    }
  }

  // 함께 쓰인 기억: 거의 모든 기억을 한꺼번에 넣은 답변(기억이 적을 때)은 관계를 말해 주지 않으므로 뺀다
  const alive = new Set(ids);
  const together = new Map<string, number>();
  for (const set of store.injectedSets()) {
    const s = [...new Set(set)].filter((id) => alive.has(id));
    if (s.length < 2 || s.length >= Math.ceil(alive.size * 0.8)) continue;
    for (let i = 0; i < s.length; i++)
      for (let j = i + 1; j < s.length; j++) {
        const [a, b] = [s[i] as string, s[j] as string].sort() as [string, string];
        const key = `${a}|${b}`;
        together.set(key, (together.get(key) ?? 0) + 1);
      }
  }
  const perNode = new Map<string, { other: string; n: number }[]>();
  for (const [key, n] of together) {
    if (n < GRAPH_CO_MIN) continue;
    const [a, b] = key.split("|") as [string, string];
    perNode.set(a, [...(perNode.get(a) ?? []), { other: b, n }]);
    perNode.set(b, [...(perNode.get(b) ?? []), { other: a, n }]);
  }
  for (const [id, list] of perNode)
    for (const t of list.sort((x, y) => y.n - x.n).slice(0, GRAPH_CO_USED)) add(id, t.other, "co_used", t.n);

  return { similarity: pairs ? "embedding" : "keyword", edges };
}
