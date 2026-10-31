// Skill 꾸러미 검증 (폴더·zip·직접 작성 공통). 파일 목록을 받아 구조·이름·상한·경로·종류를 검사한다.
// 디스크에 쓰기 전에 끝내므로 zip-slip·링크·실행 파일이 설치 폴더에 닿지 않는다
import { commandKey, commandNameError, SCRIPT_RUNNERS, SKILL_LIMITS } from "@proprix/shared";
import { sha256 } from "../tools/files";

export class SkillError extends Error {}

export interface SkillFile {
  path: string; // 꾸러미 안 상대 경로 ('/' 구분)
  data: Uint8Array;
}

export interface SkillPackage {
  name: string;
  description: string;
  body: string; // SKILL.md 본문 (frontmatter 뺌)
  files: SkillFile[];
  hash: string;
  skipped: string[];
  notes: string[]; // 설치하면서 바꾼 것 (미리보기에 알린다)
}

const BOM = [0xef, 0xbb, 0xbf];
const hasBom = (d: Uint8Array) => d[0] === BOM[0] && d[1] === BOM[1] && d[2] === BOM[2];

/**
 * Windows PowerShell 5.1 은 BOM 없는 .ps1 을 CP949 로 읽어 한글 등이 깨진다 → ASCII 밖 글자가 있는 UTF-8 .ps1 에 BOM 을 붙인다
 * (PowerShell 7 은 BOM 이 있어도 그대로 읽는다)
 */
function ps1WithBom(files: SkillFile[]): { files: SkillFile[]; changed: string[] } {
  const changed: string[] = [];
  const out = files.map((f) => {
    if (extOf(f.path) !== "ps1" || hasBom(f.data) || !f.data.some((b) => b >= 0x80)) return f;
    try {
      utf8.decode(f.data);
    } catch {
      return f; // UTF-8 이 아니면 (CP949 로 쓴 파일) 그대로
    }
    changed.push(f.path);
    return { path: f.path, data: new Uint8Array([...BOM, ...f.data]) };
  });
  return { files: out, changed };
}

// 받는 확장자 (글·데이터·스크립트·이미지). 그 밖은 거부
const ALLOWED_EXT = new Set([
  "md",
  "markdown",
  "txt",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "csv",
  "tsv",
  "xml",
  "html",
  "css",
  "svg",
  "py",
  "js",
  "mjs",
  "cjs",
  "ts",
  "ps1",
  "sh",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "pdf",
]);
// 실행 파일·라이브러리·바로 가기: 따로 이유를 알린다
const BLOCKED_EXT = new Set([
  "exe",
  "dll",
  "msi",
  "bat",
  "cmd",
  "scr",
  "com",
  "vbs",
  "vbe",
  "lnk",
  "jar",
  "ps1xml",
  "psm1",
]);
// 확장자 없이 받는 이름
const PLAIN_NAMES = new Set(["license", "notice", "readme", "authors", "copying"]);
// 조용히 건너뛰는 것 (zip·폴더에 흔히 섞임)
const SKIP_NAMES = new Set(["thumbs.db", "desktop.ini"]);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_PATH_CHARS = 200;

export const extOf = (path: string) => {
  const base = path.split("/").at(-1) ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

/**
 * 꾸러미 안 경로를 '/' 구분 상대 경로로 맞춘다. 건너뛸 것은 null.
 * 거부: 절대 경로·드라이브·'..'·'.'·빈 단계·':'(ADS)·제어 문자·예약 이름·끝 점/공백·깊이·길이
 */
export function normalizePath(raw: string): string | null {
  const p = raw.replaceAll("\\", "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new SkillError(`절대 경로는 받지 않습니다: ${raw}`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 제어 문자를 막는다
  if (/[\x00-\x1f:*?"<>|]/.test(p)) throw new SkillError(`쓸 수 없는 글자가 든 경로입니다: ${raw}`);
  const segs = p.split("/");
  if (segs.at(-1) === "") segs.pop(); // 폴더 항목 'a/'
  if (segs.length === 0) return null;
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") throw new SkillError(`잘못된 경로입니다 (빈 단계·'.'·'..'): ${raw}`);
    if (/[. ]$/.test(s)) throw new SkillError(`이름이 점·공백으로 끝납니다: ${raw}`);
    if (RESERVED.test(s.split(".")[0] ?? "")) throw new SkillError(`예약된 이름입니다: ${raw}`);
  }
  if (
    segs[0] === "__MACOSX" ||
    segs.some((s) => s.startsWith(".")) ||
    SKIP_NAMES.has((segs.at(-1) ?? "").toLowerCase())
  )
    return null;
  if (segs.length > SKILL_LIMITS.depth)
    throw new SkillError(`폴더 깊이가 ${SKILL_LIMITS.depth}단계를 넘습니다: ${raw}`);
  const out = segs.join("/");
  if (out.length > MAX_PATH_CHARS) throw new SkillError(`경로가 너무 깁니다: ${raw}`);
  return out;
}

/** 파일 종류 검사: 실행 파일·라이브러리는 거부, 허용 목록 밖도 거부 */
function checkKind(path: string) {
  const ext = extOf(path);
  if (BLOCKED_EXT.has(ext)) throw new SkillError(`실행 파일·라이브러리는 받지 않습니다: ${path}`);
  if (ext === "" && PLAIN_NAMES.has((path.split("/").at(-1) ?? "").toLowerCase())) return;
  if (!ALLOWED_EXT.has(ext)) throw new SkillError(`받지 않는 파일 종류입니다: ${path}`);
}

/** SKILL.md 앞의 --- 사이 YAML (key: value, 따옴표, | · > 여러 줄만) */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = (m[1] ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i] ?? "");
    if (!kv) continue;
    const key = kv[1] ?? "";
    let value = (kv[2] ?? "").trim();
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1] ?? "")) block.push((lines[++i] ?? "").trim());
      value = block.join(value.startsWith("|") ? "\n" : " ").trim();
    } else if (/^".*"$/.test(value)) {
      try {
        value = String(JSON.parse(value)); // "…" 안의 \" · \\ 를 푼다
      } catch {
        value = value.slice(1, -1);
      }
    } else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replaceAll("''", "'");
    meta[key] = value;
  }
  return { meta, body: text.slice(m[0].length) };
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function packageHash(files: SkillFile[]): string {
  return sha256(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((f) => `${f.path}\0${sha256(f.data)}\n`)
      .join(""),
  );
}

/**
 * 파일 목록 → 꾸러미. folderName 이 있으면 SKILL.md 의 name 과 같아야 한다 (영문 대소문자 무시).
 * 경로는 normalizePath 로 맞춘 뒤 넘긴다 (sources.ts)
 */
export function checkPackage(files: SkillFile[], skipped: string[] = [], folderName?: string): SkillPackage {
  if (files.length > SKILL_LIMITS.files) throw new SkillError(`파일이 ${SKILL_LIMITS.files}개를 넘습니다`);
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > SKILL_LIMITS.totalBytes) throw new SkillError("전체 크기가 20MB 를 넘습니다");
  const seen = new Set<string>();
  for (const f of files) {
    const key = f.path.toLowerCase(); // Windows 는 대소문자만 다른 두 파일을 함께 둘 수 없다
    if (seen.has(key)) throw new SkillError(`같은 경로가 두 번 있습니다: ${f.path}`);
    seen.add(key);
    checkKind(f.path);
  }
  const md = files.find((f) => f.path === "SKILL.md");
  if (!md) throw new SkillError("맨 위에 SKILL.md 가 있어야 합니다");
  if (md.data.length > SKILL_LIMITS.skillMdBytes) throw new SkillError("SKILL.md 는 1MB 까지입니다");
  let text: string;
  try {
    text = utf8.decode(md.data);
  } catch {
    throw new SkillError("SKILL.md 가 UTF-8 이 아닙니다");
  }
  const { meta, body } = parseFrontmatter(text);
  const name = (meta.name ?? "").normalize("NFC");
  const description = (meta.description ?? "").trim();
  if (!name || !description) throw new SkillError("SKILL.md 앞부분(---)에 name 과 description 이 있어야 합니다");
  const nameError = commandNameError(name);
  if (nameError) throw new SkillError(`Skill 이름 '${name}': ${nameError}`);
  if (description.length > SKILL_LIMITS.description)
    throw new SkillError(`description 은 ${SKILL_LIMITS.description}자까지입니다`);
  if (folderName !== undefined && commandKey(folderName) !== commandKey(name))
    throw new SkillError(`폴더 이름(${folderName})과 SKILL.md 의 name(${name})이 다릅니다`);
  const fixed = ps1WithBom(files);
  const notes = fixed.changed.map(
    (p) => `${p}: Windows PowerShell 5.1 이 글자를 깨뜨리지 않게 UTF-8 BOM 을 붙여 설치합니다`,
  );
  return { name, description, body: body.trim(), files: fixed.files, hash: packageHash(fixed.files), skipped, notes };
}

/** 실행할 수 있는 스크립트 (확장자로 실행기를 정한다) */
export function scriptsOf(files: { path: string }[]) {
  return files.flatMap((f) => {
    const runner = SCRIPT_RUNNERS[extOf(f.path)];
    return runner ? [{ path: f.path, runner }] : [];
  });
}
