// Tauri 앞 단계: SPA 를 빌드하고 daemon 을 단일 실행 파일(sidecar)로 묶는다.
// @huggingface/transformers(onnxruntime 네이티브 모듈)는 묶지 않고 embedding-runtime 폴더로 함께 설치한다
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const run = (cmd: string[], cwd = root) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`실패: ${cmd.join(" ")}`);
};

// Tauri sidecar 이름 규칙: <이름>-<target triple>(.exe)
const triple = /host: (\S+)/.exec(Bun.spawnSync(["rustc", "-vV"]).stdout.toString())?.[1];
if (!triple) throw new Error("rustc -vV 에서 target triple 을 찾지 못함");
const outDir = join(root, "apps/desktop/src-tauri/binaries");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `proprix-daemon-${triple}${process.platform === "win32" ? ".exe" : ""}`);

run(["bun", "apps/desktop/scripts/build-notices.ts"]); // SPA 빌드에 포함되도록 먼저
run(["bun", "apps/desktop/scripts/build-embedding-runtime.ts"]);
run(["bun", "run", "build:web"]);
run([
  "bun",
  "build",
  "--compile",
  "--minify",
  "--external",
  "@huggingface/transformers",
  "apps/daemon/src/main.ts",
  "--outfile",
  out,
]);
console.log(`[sidecar] ${out}`);
