// bun run memory:eval [--data=path.json] [--k=5] [--repeat=5] [--variants=이름,…] [--misses] [--out=docs/memory-eval.md]
//                     [--embed=e5-small,embeddinggemma] [--models-dir=.data/models]
// 기본 평가셋은 합성 예시(data/example.json). 개인 평가셋은 data/ 아래에 두면 .gitignore 로 커밋되지 않는다.
// --embed: 로컬 임베딩 변형도 비교한다 (모델이 없으면 Hugging Face 에서 내려받음)
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EMBEDDING_MODELS, Embedder } from "../embedding";
import { EvalDataset, evaluate, toMarkdown, VARIANTS, type VectorSet, vectorVariants } from "./evaluate";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dataPath = arg("data") ?? join(import.meta.dir, "data", "example.json");
const k = Number(arg("k") ?? 5);
const repeat = Number(arg("repeat") ?? 5);
const embedIds = arg("embed")?.split(",").filter(Boolean) ?? [];
const modelsDir = resolve(arg("models-dir") ?? join(import.meta.dir, "../../../../../.data/models"));

const ds = EvalDataset.parse(JSON.parse(readFileSync(dataPath, "utf8")));

const vectors: VectorSet[] = [];
for (const id of embedIds) {
  const model = EMBEDDING_MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`모르는 임베딩 모델: ${id} (${EMBEDDING_MODELS.map((m) => m.id).join(", ")})`);
  let t = performance.now();
  const embedder = await Embedder.load(model, modelsDir);
  console.error(`[embed] ${id} 로드 ${(performance.now() - t).toFixed(0)}ms`);
  t = performance.now();
  const docVecs = await embedder.embedDocs(ds.memories.map((m) => m.content));
  console.error(`[embed] ${id} 기억 ${ds.memories.length}개 ${(performance.now() - t).toFixed(0)}ms`);
  const queries = new Map<string, { vec: Float32Array; ms: number }>();
  for (const q of ds.queries) {
    t = performance.now();
    const [vec] = await embedder.embedQueries([q.q]);
    if (vec) queries.set(q.q, { vec, ms: performance.now() - t });
  }
  vectors.push({ model: id, docs: new Map(ds.memories.map((m, i) => [m.key, docVecs[i] as Float32Array])), queries });
}

const all = [...VARIANTS, ...vectorVariants(embedIds)];
const only = arg("variants")?.split(",");
const variants = only ? all.filter((v) => only.some((o) => v.name.startsWith(o))) : all;

const results = evaluate(ds, variants, k, repeat, vectors);
const md = toMarkdown(ds, results, k);
console.log(md);

if (process.argv.includes("--misses"))
  for (const r of results) {
    console.log(`\n## 놓친 질문 — ${r.variant.name} (${r.misses.length})`);
    for (const m of r.misses)
      console.log(`- [${m.type}] ${m.q} → 기대 ${m.expect.join(",")} / 결과 ${m.got.join(",") || "없음"}`);
  }

const out = arg("out");
if (out) {
  writeFileSync(out, `${md}\n`);
  console.log(`\n→ ${out}`);
}
