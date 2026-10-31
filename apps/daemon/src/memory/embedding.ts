// 로컬 임베딩 (실험·선택 기능): transformers.js(ONNX) 로 문장 벡터를 만든다. 모델은 사용자가 고르고 처음 쓸 때 내려받는다.
// SIWC 토큰으로는 embeddings API 를 쓸 수 없어 로컬에서 계산한다.
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

export class Embedder {
  private constructor(
    readonly model: EmbeddingModel,
    private readonly run: Run,
  ) {}

  // cacheDir 에 없으면 Hugging Face 에서 내려받는다
  static async load(model: EmbeddingModel, cacheDir: string): Promise<Embedder> {
    const hf = await import("@huggingface/transformers");
    hf.env.cacheDir = cacheDir;
    hf.env.allowLocalModels = false;
    if (model.kind === "pipeline") {
      const extractor = await hf.pipeline("feature-extraction", model.repo, { dtype: model.dtype });
      return new Embedder(model, async (texts) => {
        const out = await extractor(texts, { pooling: "mean", normalize: true });
        return split(out.data as Float32Array, texts.length, model.dims);
      });
    }
    const tokenizer = await hf.AutoTokenizer.from_pretrained(model.repo);
    const net = await hf.AutoModel.from_pretrained(model.repo, { dtype: model.dtype });
    return new Embedder(model, async (texts) => {
      const inputs = await tokenizer(texts, { padding: true, truncation: true });
      const { sentence_embedding } = await net(inputs);
      return split(normalizeRows(sentence_embedding.data as Float32Array, model.dims), texts.length, model.dims);
    });
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
