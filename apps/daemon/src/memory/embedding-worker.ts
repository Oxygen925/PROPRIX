// 설치 앱의 로컬 임베딩 프로세스 (embedding.ts 의 startWorker 가 띄운다). 단일 실행 파일 안에서는 패키지 이름을
// 찾지 못해 transformers 를 부를 수 없으므로, 같은 실행 파일을 bun 으로 다시 실행해 이 파일을 돌린다.
// daemon 이 끝나면(IPC 끊김) 함께 끝난다
import { EMBEDDING_MODELS, loadRun } from "./embedding";

const [, , modelId, cacheDir] = process.argv;
const send = (m: unknown) => process.send?.(m);

process.on("disconnect", () => process.exit(0));

const model = EMBEDDING_MODELS.find((m) => m.id === modelId);
try {
  if (!model || !cacheDir) throw new Error(`없는 임베딩 모델: ${modelId}`);
  const run = await loadRun(model, cacheDir);
  process.on("message", (m: { id: number; texts: string[] }) => {
    run(m.texts).then(
      (rows) =>
        send({ id: m.id, rows: rows.map((r) => Buffer.from(r.buffer, r.byteOffset, r.byteLength).toString("base64")) }),
      (err: unknown) => send({ id: m.id, error: err instanceof Error ? err.message : String(err) }),
    );
  });
  send({ ready: true });
} catch (err) {
  send({ failed: err instanceof Error ? err.message : String(err) });
  setTimeout(() => process.exit(1), 100);
}
