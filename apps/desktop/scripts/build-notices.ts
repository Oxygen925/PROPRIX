// 설치본에 들어가는 제3자 라이선스를 모은다: apps/web/static/THIRD_PARTY_NOTICES.txt (빌드 산출물, git 제외).
// npm: web·daemon 의 dependencies 를 따라간 전부와 번들되는 svelte. Rust: 셸의 일반 의존성 (Windows 대상).
// 같은 본문은 한 번만 싣는다. EXCLUDED 는 설치본에 넣지 않는 것 (build-embedding-runtime.ts 의 SKIP)
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "../../..");
const out = join(root, "apps/web/static/THIRD_PARTY_NOTICES.txt");
const EXCLUDED = new Set(["onnxruntime-web", "sharp", "global-agent", "adm-zip"]);
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;
// 패키지에 라이선스 본문이 없어 저장소에 둔 것. 원 저장소 파일을 옮겼고(저작권자 이메일은 뺐다),
// is-reference·locate-character 는 원 저장소에서도 파일을 찾지 못해 선언한 MIT 표준 문구에 저작자 이름을 넣었다
const NOTICES = "apps/desktop/notices";
const EXTRA_TEXTS: Record<string, string> = {
  pretendard: `${NOTICES}/pretendard-OFL-1.1.txt`,
  "@polka/url": `${NOTICES}/lukeed-MIT.txt`,
  sirv: `${NOTICES}/lukeed-MIT.txt`,
  "is-reference": `${NOTICES}/rich-harris-MIT.txt`,
  "locate-character": `${NOTICES}/rich-harris-MIT.txt`,
  "alloc-stdlib": `${NOTICES}/alloc-stdlib-BSD-3-Clause.txt`,
  selectors: `${NOTICES}/selectors-MPL-2.0.txt`,
  "webview2-com": `${NOTICES}/webview2-rs-MIT.txt`,
  "webview2-com-macros": `${NOTICES}/webview2-rs-MIT.txt`,
  "webview2-com-sys": `${NOTICES}/webview2-rs-MIT.txt`,
  "onnxruntime-common": `${NOTICES}/onnxruntime-MIT.txt`,
  "onnxruntime-node": `${NOTICES}/onnxruntime-MIT.txt`,
};

interface Item {
  name: string;
  version: string;
  license: string;
  texts: string[];
}

const textsIn = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name))
    .map((e) => readFileSync(join(dir, e.name), "utf8").replaceAll("\r\n", "\n").trim());

const extraTexts = (name: string) => {
  const file = EXTRA_TEXTS[name];
  return file ? [readFileSync(join(root, file), "utf8").trim()] : [];
};

// node_modules 를 위로 올라가며 찾는다 (bun 의 격리 설치도 심볼릭 링크로 같은 모양이다)
function resolvePackage(from: string, name: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, "node_modules", name);
    if (existsSync(join(p, "package.json"))) return realpathSync(p);
    if (dirname(dir) === dir) return null;
  }
}

function npmItems(): Item[] {
  const items = new Map<string, Item>();
  const seen = new Set<string>();
  const walk = (dir: string, isRoot: boolean, extra: readonly string[] = []) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (!isRoot && !dir.startsWith(join(root, "packages"))) {
      const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "UNKNOWN");
      items.set(`${pkg.name}@${pkg.version}`, {
        name: pkg.name,
        version: pkg.version,
        license,
        texts: [...textsIn(dir), ...extraTexts(pkg.name)],
      });
    }
    for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...extra]) {
      if (EXCLUDED.has(dep)) continue;
      const found = resolvePackage(dir, dep);
      if (found) walk(found, false);
    }
  };
  walk(join(root, "apps/web"), true, ["svelte", "@sveltejs/kit"]);
  walk(join(root, "apps/daemon"), true);
  return [...items.values()];
}

function rustItems(): Item[] {
  const r = Bun.spawnSync(
    ["cargo", "metadata", "--format-version", "1", "--filter-platform", "x86_64-pc-windows-msvc"],
    { cwd: join(root, "apps/desktop/src-tauri") },
  );
  if (r.exitCode !== 0) throw new Error(`cargo metadata 실패: ${r.stderr.toString()}`);
  const meta = JSON.parse(r.stdout.toString());
  const packages = new Map<string, { name: string; version: string; license?: string; manifest_path: string }>(
    meta.packages.map((p: { id: string }) => [p.id, p]),
  );
  const nodes = new Map<string, { deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }>(
    meta.resolve.nodes.map((n: { id: string }) => [n.id, n]),
  );
  const seen = new Set<string>();
  const stack: string[] = [meta.resolve.root];
  const items: Item[] = [];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const p = packages.get(id);
    if (p && id !== meta.resolve.root)
      items.push({
        name: p.name,
        version: p.version,
        license: p.license ?? "UNKNOWN",
        texts: [...textsIn(dirname(p.manifest_path)), ...extraTexts(p.name)],
      });
    for (const d of nodes.get(id)?.deps ?? []) if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
  }
  return items;
}

// onnxruntime.dll 에 포함된 라이브러리 고지. 제3자 이메일이 많아 저장소에 넣지 않고 빌드할 때 받는다
const ONNX_NOTICES = "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/ThirdPartyNotices.txt";
const onnxNotices = await fetch(ONNX_NOTICES);
if (!onnxNotices.ok) throw new Error(`onnxruntime 고지를 받지 못했습니다: ${onnxNotices.status}`);
const onnxNoticesText = (await onnxNotices.text()).replaceAll("\r\n", "\n").trim();

const all = [...npmItems(), ...rustItems()].sort((a, b) => a.name.localeCompare(b.name));
for (const item of all) if (item.name === "onnxruntime-node") item.texts.push(onnxNoticesText);
const bodies = new Map<string, string[]>();
const lines = [
  "PROPRIX 설치본에 포함된 제3자 소프트웨어",
  "Third-party software included in the PROPRIX installer",
  "",
  ...all.map((i) => `${i.name} ${i.version} — ${i.license}`),
  "",
  "ChatGPT 로고는 OpenAI 의 상표이며 PROPRIX 의 MIT 라이선스가 적용되지 않습니다.",
  "The ChatGPT logo is a trademark of OpenAI and is not covered by the PROPRIX MIT license.",
  "",
];
for (const item of all)
  for (const text of item.texts) bodies.set(text, [...(bodies.get(text) ?? []), `${item.name} ${item.version}`]);
for (const [text, owners] of bodies)
  lines.push("=".repeat(72), `적용 대상: ${owners.join(", ")}`, "=".repeat(72), "", text, "");
const noText = all.filter((i) => i.texts.length === 0).length;
writeFileSync(out, lines.join("\n"));
console.log(`[notices] ${all.length}개, 본문 ${bodies.size}종, 본문 파일 없는 항목 ${noText}개 → ${out}`);
