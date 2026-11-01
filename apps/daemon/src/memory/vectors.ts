// 로컬 임베딩 색인 (선택 기능): 기억 원문 벡터를 memory_embeddings 에 두고, 질문 벡터와 코사인으로 비교한다.
// 모델은 설정에서 켤 때 불러온다(처음이면 Hugging Face 에서 내려받음). 불러오기·추론이 실패하면 키워드 검색만 쓴다.
// 점수가 평균 + 2σ 이상인 것만 후보로 낸다 — P3d 평가에서 무관 결과를 키워드 수준으로 유지한 설정 (docs/memory-eval.md).
import type { Database } from "bun:sqlite";
import type { EmbeddingStatus } from "@proprix/shared";
import { cosine, EMBEDDING_MODELS, type EmbeddingModel } from "./embedding";

type ModelId = EmbeddingStatus["model"];

export interface EmbedFns {
  embedQueries(texts: string[]): Promise<Float32Array[]>;
  embedDocs(texts: string[]): Promise<Float32Array[]>;
  dispose?(): void;
}
export type EmbedLoader = (model: EmbeddingModel) => Promise<EmbedFns>;

export const Z_CUT = 2;
const BATCH = 16;

const hashOf = (text: string) => Bun.hash(text).toString(36);

export class VectorIndex {
  private model: ModelId = "off";
  private fns: EmbedFns | null = null;
  private state: EmbeddingStatus["state"] = "off";
  private error = "";
  private generation = 0; // 설정이 바뀌면 이전 불러오기·색인 결과를 버린다
  private indexing: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly db: Database,
    private readonly load: EmbedLoader,
    private readonly onStatus: (s: EmbeddingStatus) => void = () => {},
  ) {}

  status(): EmbeddingStatus {
    const total =
      this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memories WHERE superseded_by IS NULL").get()?.n ?? 0;
    const indexed =
      this.model === "off"
        ? 0
        : (this.db
            .query<{ n: number }, { model: string }>(
              `SELECT COUNT(*) AS n FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
               WHERE m.superseded_by IS NULL AND e.model = $model`,
            )
            .get({ model: this.model })?.n ?? 0);
    return { model: this.model, state: this.state, error: this.error, indexed, total };
  }

  private publish() {
    this.onStatus(this.status());
  }

  // 설정 반영. 같은 모델이면 아무것도 하지 않는다
  configure(model: ModelId): Promise<void> {
    if (model === this.model && this.state !== "failed") return Promise.resolve();
    const gen = ++this.generation;
    this.model = model;
    this.fns?.dispose?.();
    this.fns = null;
    this.error = "";
    if (model === "off") {
      this.state = "off";
      this.publish();
      return Promise.resolve();
    }
    const spec = EMBEDDING_MODELS.find((m) => m.id === model);
    if (!spec) return Promise.resolve();
    this.state = "loading";
    this.publish();
    const started = performance.now();
    return this.load(spec).then(
      (fns) => {
        if (gen !== this.generation) {
          fns.dispose?.();
          return;
        }
        this.fns = fns;
        this.state = "ready";
        console.log(`[embedding] ${model} 준비 ${(performance.now() - started).toFixed(0)}ms`);
        this.publish();
        this.schedule();
      },
      (err: unknown) => {
        if (gen !== this.generation) return;
        this.fail(err);
      },
    );
  }

  // 앱 종료: 임베딩 프로세스를 끝낸다
  stop() {
    this.generation++;
    this.fns?.dispose?.();
    this.fns = null;
  }

  private fail(err: unknown) {
    this.state = "failed";
    this.fns?.dispose?.();
    this.fns = null;
    this.error = err instanceof Error ? err.message : String(err);
    console.warn(`[embedding] 실패 — 키워드 검색만 사용: ${this.error}`);
    this.publish();
  }

  // 기억이 바뀌면 호출: 벡터가 없거나 내용이 바뀐 활성 기억을 백그라운드로 계산한다
  schedule(): Promise<void> {
    if (!this.fns) return Promise.resolve();
    if (this.indexing) {
      this.again = true;
      return this.indexing;
    }
    this.indexing = this.indexPending().finally(() => {
      this.indexing = null;
      if (this.again) {
        this.again = false;
        void this.schedule();
      }
    });
    return this.indexing;
  }

  private pending(limit: number): { id: string; content: string }[] {
    return this.db
      .query<{ id: string; content: string; hash: string | null; model: string | null }, []>(
        `SELECT m.id, m.content, e.text_hash AS hash, e.model FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id WHERE m.superseded_by IS NULL`,
      )
      .all()
      .filter((r) => r.model !== this.model || r.hash !== hashOf(r.content))
      .slice(0, limit);
  }

  private async indexPending() {
    const gen = this.generation;
    let changed = false;
    for (;;) {
      const fns = this.fns;
      if (!fns || gen !== this.generation) break;
      const rows = this.pending(BATCH);
      if (rows.length === 0) break;
      let vecs: Float32Array[];
      try {
        vecs = await fns.embedDocs(rows.map((r) => r.content));
      } catch (err) {
        if (gen === this.generation) this.fail(err);
        return;
      }
      if (gen !== this.generation) return;
      const now = Date.now();
      const upsert = this.db.query(
        `INSERT INTO memory_embeddings (memory_id, model, text_hash, vec, updated_at)
         VALUES ($id, $model, $hash, $vec, $now)
         ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, text_hash = excluded.text_hash,
         vec = excluded.vec, updated_at = excluded.updated_at`,
      );
      this.db.transaction(() => {
        rows.forEach((r, i) => {
          const v = vecs[i];
          if (!v) return;
          upsert.run({
            id: r.id,
            model: this.model,
            hash: hashOf(r.content),
            vec: new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
            now,
          });
        });
      })();
      changed = true;
    }
    if (changed) {
      console.log(`[embedding] 색인 ${this.status().indexed}/${this.status().total}`);
      this.publish();
    }
  }

  // 그래프 (P10e): 기억마다 가장 비슷한 기억 (자기 점수 분포에서 평균 + z 이상, 많아야 k 개). 꺼져 있으면 null
  similarPairs(ids: readonly string[], k: number, z: number): { a: string; b: string; s: number }[] | null {
    if (!this.fns || this.model === "off") return null;
    const want = new Set(ids);
    const rows = this.db
      .query<{ id: string; vec: Uint8Array }, { model: string }>(
        "SELECT memory_id AS id, vec FROM memory_embeddings WHERE model = $model",
      )
      .all({ model: this.model })
      .filter((r) => want.has(r.id))
      .map((r) => ({ id: r.id, v: new Float32Array(new Uint8Array(r.vec).buffer) }));
    const out: { a: string; b: string; s: number }[] = [];
    for (const x of rows) {
      const scored = rows.filter((y) => y.id !== x.id).map((y) => ({ id: y.id, s: cosine(x.v, y.v) }));
      if (scored.length < 2) continue;
      const mean = scored.reduce((a, t) => a + t.s, 0) / scored.length;
      const std = Math.sqrt(scored.reduce((a, t) => a + (t.s - mean) ** 2, 0) / scored.length) || 1;
      for (const t of scored
        .filter((t) => (t.s - mean) / std >= z)
        .sort((p, q) => q.s - p.s)
        .slice(0, k))
        out.push({ a: x.id, b: t.id, s: t.s });
    }
    return out;
  }

  // 질문과 가까운 활성 기억 id (평균 + 2σ 이상, 점수 순). 꺼져 있거나 실패하면 []
  async search(query: string, scopes: string[], limit: number): Promise<string[]> {
    const fns = this.fns;
    if (!fns || !query.trim() || scopes.length === 0) return [];
    let qv: Float32Array | undefined;
    try {
      [qv] = await fns.embedQueries([query]);
    } catch (err) {
      this.fail(err);
      return [];
    }
    if (!qv) return [];
    const params: Record<string, string | number> = { model: this.model, now: Date.now() };
    const names = scopes.map((s, i) => {
      params[`s${i}`] = s;
      return `$s${i}`;
    });
    const rows = this.db
      .query<{ id: string; vec: Uint8Array }, Record<string, string | number>>(
        `SELECT m.id, e.vec FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
         WHERE e.model = $model AND m.scope IN (${names.join(", ")}) AND m.superseded_by IS NULL
           AND (m.valid_until IS NULL OR m.valid_until > $now)`,
      )
      .all(params);
    const scored = rows.map((r) => ({
      id: r.id,
      s: cosine(qv, new Float32Array(new Uint8Array(r.vec).buffer)), // 복사해 4바이트 정렬을 맞춘다
    }));
    if (scored.length === 0) return [];
    const mean = scored.reduce((a, x) => a + x.s, 0) / scored.length;
    const std = Math.sqrt(scored.reduce((a, x) => a + (x.s - mean) ** 2, 0) / scored.length) || 1;
    return scored
      .filter((x) => (x.s - mean) / std >= Z_CUT)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.id);
  }
}
