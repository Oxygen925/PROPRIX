// 로컬 임베딩 실행 파일을 src-tauri/embedding-runtime/node_modules 에 모은다 (빌드 산출물, git 제외).
// 단일 실행 파일에서는 패키지 이름을 찾지 못하므로 설치본에 폴더로 넣고 별도 프로세스로 돌린다 (embedding-worker.ts).
// Windows x64 파일만 남긴다. 빼는 것: 브라우저용 onnxruntime-web, 이미지용 sharp(문장 임베딩에 쓰지 않아 빈 모듈로 대신한다),
// onnxruntime 설치 스크립트 전용 의존성, GPU 용 DirectML DLL (CPU 로만 돈다)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "../../..");
const out = process.argv[2] ?? join(root, "apps/desktop/src-tauri/embedding-runtime");
const SKIP = ["onnxruntime-web", "sharp", "global-agent", "adm-zip"];

function resolvePackage(from: string, name: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, "node_modules", name);
    if (existsSync(join(p, "package.json"))) return realpathSync(p);
    if (dirname(dir) === dir) return null;
  }
}

rmSync(out, { recursive: true, force: true });
const modules = join(out, "node_modules");
const seen = new Set<string>();

function copy(name: string, from: string) {
  if (seen.has(name) || SKIP.includes(name)) return;
  const dir = resolvePackage(from, name);
  if (!dir) return; // 다른 플랫폼용 선택 의존성
  seen.add(name);
  const target = join(modules, name);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(dir, target, { recursive: true, dereference: true, filter: (src) => !src.endsWith("node_modules") });
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})])
    copy(dep, dir);
}

copy("@huggingface/transformers", join(root, "apps/daemon"));

// onnxruntime-node: Windows x64 만 남긴다
const ort = join(modules, "onnxruntime-node/bin");
for (const napi of readdirSync(ort))
  for (const platform of readdirSync(join(ort, napi)))
    if (platform !== "win32") rmSync(join(ort, napi, platform), { recursive: true, force: true });
    else
      for (const arch of readdirSync(join(ort, napi, platform)))
        if (arch !== "x64") rmSync(join(ort, napi, platform, arch), { recursive: true, force: true });

for (const napi of readdirSync(ort)) {
  const dir = join(ort, napi, "win32/x64");
  for (const name of ["DirectML.dll", "dxcompiler.dll", "dxil.dll"]) rmSync(join(dir, name), { force: true });
}

// transformers 가 불러오기만 하는 sharp 자리 (값이 비어 있으면 불러올 때 오류를 낸다)
const sharp = join(modules, "sharp");
mkdirSync(sharp, { recursive: true });
writeFileSync(join(sharp, "package.json"), JSON.stringify({ name: "sharp", version: "0.0.0", main: "index.js" }));
writeFileSync(
  join(sharp, "index.js"),
  'module.exports = () => { throw new Error("embedding-runtime: 이미지 처리는 포함하지 않았습니다"); };\n',
);

const built = Bun.spawnSync(
  [
    "bun",
    "build",
    "apps/daemon/src/memory/embedding-worker.ts",
    "--target",
    "bun",
    "--external",
    "@huggingface/transformers",
    "--outfile",
    join(out, "worker.mjs"),
  ],
  { cwd: root, stdout: "ignore", stderr: "inherit" },
);
if (built.exitCode !== 0) throw new Error("embedding-worker 빌드 실패");

console.log(`[embedding-runtime] ${seen.size}개 → ${out}`);
