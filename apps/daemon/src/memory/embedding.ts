// 로컬 임베딩 (실험·선택 기능): transformers.js(ONNX) 로 문장 벡터를 만든다. 모델은 사용자가 고르고 처음 쓸 때 내려받는다.
// SIWC 토큰으로는 embeddings API 를 쓸 수 없어 로컬에서 계산한다.
// 설치 앱은 설치 폴더의 embedding-runtime 을 별도 프로세스로 돌린다 (embedding-worker.ts)
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface EmbeddingModel {
  id: string;
  title: string;
  repo: string; // Hugging Face 저장소
  dtype: "q8" | "q4" | "fp32";
  dims: number;
  // 검색 질문·저장 문서에 붙이는 접두어 (모델 카드 기준)
  queryPrefix: string;
  docPrefix: string;
  // pipeline: feature-extraction 평균 풀링 / sentence: AutoModel 의 sentence_embedding 출력
  kind: "pipeline" | "sentence";
  sizeMb: number;
}

export const EMBEDDING_MODELS: readonly EmbeddingModel[] = [
  {
    id: "e5-small",
    title: "multilingual-e5-small (8비트)",
    repo: "Xenova/multilingual-e5-small",
    dtype: "q8",
    dims: 384,
    queryPrefix: "query: ",
    docPrefix: "passage: ",
    kind: "pipeline",
    sizeMb: 118,
  },
  {
    id: "embeddinggemma",
    title: "EmbeddingGemma 300M (4비트)",
    repo: "onnx-community/embeddinggemma-300m-ONNX",
    dtype: "q4",
    dims: 768,
    queryPrefix: "task: search result | query: ",
    docPrefix: "title: none | text: ",
    kind: "sentence",
    sizeMb: 197,
  },
];

type Run = (texts: string[]) => Promise<Float32Array[]>;

// cacheDir 에 없으면 Hugging Face 에서 내려받는다
export async function loadRun(model: EmbeddingModel, cacheDir: string): Promise<Run> {
  const hf = await import("@huggingface/transformers");
  hf.env.cacheDir = cacheDir;
  hf.env.allowLocalModels = false;
  if (model.kind === "pipeline") {
    const extractor = await hf.pipeline("feature-extraction", model.repo, { dtype: model.dtype });
    return async (texts) => {
      const out = await extractor(texts, { pooling: "mean", normalize: true });
      return split(out.data as Float32Array, texts.length, model.dims);
    };
  }
  const tokenizer = await hf.AutoTokenizer.from_pretrained(model.repo);
  const net = await hf.AutoModel.from_pretrained(model.repo, { dtype: model.dtype });
  return async (texts) => {
    const inputs = await tokenizer(texts, { padding: true, truncation: true });
    const { sentence_embedding } = await net(inputs);
    return split(normalizeRows(sentence_embedding.data as Float32Array, model.dims), texts.length, model.dims);
  };
}

type WorkerMessage = { ready: true } | { failed: string } | { id: number; rows?: string[]; error?: string };

const fromBase64 = (s: string) => {
  const bytes = Buffer.from(s, "base64");
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
};

// 같은 실행 파일을 bun 으로 다시 실행해 worker 를 돌린다. 앱 토큰 같은 환경 변수는 넘기지 않는다
function startWorker(worker: string, model: EmbeddingModel, cacheDir: string): Promise<{ run: Run; stop: () => void }> {
  const env: Record<string, string | undefined> = { ...process.env, BUN_BE_BUN: "1" };
  for (const key of Object.keys(env)) if (key.startsWith("PROPRIX_")) delete env[key];
  const waiting = new Map<number, { resolve: (r: Float32Array[]) => void; reject: (e: Error) => void }>();
  let seq = 0;
  return new Promise((resolve, reject) => {
    const child = Bun.spawn([process.execPath, "run", worker, model.id, cacheDir], {
      cwd: dirname(worker),
      env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      windowsHide: true,
      ipc(raw) {
        const m = raw as WorkerMessage;
        if ("ready" in m) {
          resolve({
            run: (texts) =>
              new Promise((ok, no) => {
                if (child.killed || child.exitCode !== null) return no(new Error("임베딩 프로세스가 끝났습니다"));
                const id = ++seq;
                waiting.set(id, { resolve: ok, reject: no });
                child.send({ id, texts });
              }),
            stop: () => child.kill(),
          });
        } else if ("failed" in m) reject(new Error(m.failed));
        else {
          const w = waiting.get(m.id);
          waiting.delete(m.id);
          if (m.rows) w?.resolve(m.rows.map(fromBase64));
          else w?.reject(new Error(m.error ?? "임베딩 실패"));
        }
      },
      onExit(_p, code) {
        const err = new Error(`임베딩 프로세스가 끝났습니다 (${code})`);
        reject(err);
        for (const w of waiting.values()) w.reject(err);
        waiting.clear();
      },
    });
  });
}

export class Embedder {
  private constructor(
    readonly model: EmbeddingModel,
    private readonly run: Run,
    private readonly stop: () => void = () => {},
  ) {}

  static async load(model: EmbeddingModel, cacheDir: string): Promise<Embedder> {
    const worker = join(dirname(process.execPath), "embedding-runtime", "worker.mjs");
    if (existsSync(worker)) {
      const w = await startWorker(worker, model, cacheDir);
      return new Embedder(model, w.run, w.stop);
    }
    return new Embedder(model, await loadRun(model, cacheDir));
  }

  dispose() {
    this.stop();
  }

  embedQueries(texts: string[]): Promise<Float32Array[]> {
    return this.run(texts.map((t) => this.model.queryPrefix + t));
  }

  embedDocs(texts: string[]): Promise<Float32Array[]> {
    return this.run(texts.map((t) => this.model.docPrefix + t));
  }
}

function split(data: Float32Array, n: number, dims: number): Float32Array[] {
  return Array.from({ length: n }, (_, i) => data.slice(i * dims, (i + 1) * dims));
}

function normalizeRows(data: Float32Array, dims: number): Float32Array {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += dims) {
    let norm = 0;
    for (let j = 0; j < dims; j++) norm += (data[i + j] ?? 0) ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < dims; j++) out[i + j] = (data[i + j] ?? 0) / norm;
  }
  return out;
}

// 정규화된 벡터의 코사인 유사도 = 내적
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
