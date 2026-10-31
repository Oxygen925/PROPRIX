// 작업 폴더 보안 기준 (P7a, 사용자 결정 2026-10-29)
// 1) 폴더 지정 검증  2) 경로 해석 resolveInside — 링크·정션을 따라간 실제 경로가 폴더 안인지
// 3) 파일별 정책 WorkspacePolicy — 기본 규칙(끌 수 없음) + 방마다 더한 규칙
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export class WorkspaceError extends Error {}

export const MAX_PATH = 260;
export const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const lower = (p: string) => p.toLowerCase();
const inside = (child: string, root: string) =>
  lower(child) === lower(root) || lower(child).startsWith(lower(root).endsWith(sep) ? lower(root) : lower(root) + sep);
const real = (p: string) => realpathSync.native(p);
const isUnc = (p: string) => p.startsWith("\\\\") || p.startsWith("//");

// ---- 1) 폴더 지정 ----

/** 사용자가 고른 폴더를 검증하고 실제 경로를 돌려준다. 거부하면 WorkspaceError (사유) */
export function validateWorkspaceRoot(input: string, dataDir: string): string {
  const raw = input.trim();
  if (!raw) throw new WorkspaceError("폴더 경로가 비었습니다");
  if (isUnc(raw)) throw new WorkspaceError("네트워크·장치 경로는 쓸 수 없습니다");
  if (!isAbsolute(raw)) throw new WorkspaceError("전체 경로를 입력하세요 (예: C:\\work\\project)");
  if (!existsSync(raw) || !statSync(raw).isDirectory()) throw new WorkspaceError("없는 폴더입니다");
  const root = real(raw);
  if (isUnc(root)) throw new WorkspaceError("네트워크·장치 경로는 쓸 수 없습니다");
  if (lower(parse(root).root) === lower(root.endsWith(sep) ? root : root + sep))
    throw new WorkspaceError("드라이브 전체는 작업 폴더로 쓸 수 없습니다");
  const blocked = [
    { path: homedir(), why: "사용자 폴더 전체는 쓸 수 없습니다 (그 안의 하위 폴더를 고르세요)", exact: true },
    { path: process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", why: "시스템 폴더는 쓸 수 없습니다" },
    { path: process.env.ProgramFiles ?? "C:\\Program Files", why: "프로그램 폴더는 쓸 수 없습니다" },
    { path: process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", why: "프로그램 폴더는 쓸 수 없습니다" },
    { path: process.env.ProgramData ?? "C:\\ProgramData", why: "프로그램 데이터 폴더는 쓸 수 없습니다" },
    { path: process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), why: "앱 데이터 폴더는 쓸 수 없습니다" },
    { path: process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), why: "앱 데이터 폴더는 쓸 수 없습니다" },
  ];
  // 임시 폴더(AppData\Local\Temp)는 작업 폴더로 써도 된다
  const temp = existsSync(tmpdir()) ? real(tmpdir()) : "";
  for (const b of blocked) {
    if (!existsSync(b.path)) continue;
    const p = real(b.path);
    if (temp && inside(root, temp) && inside(temp, p)) continue;
    if (b.exact ? lower(p) === lower(root) : inside(root, p)) throw new WorkspaceError(b.why);
  }
  // 데이터 폴더 안은 안 된다. 데이터 폴더를 품은 폴더는 되지만 그 안은 기본 규칙으로 막는다 (protectedRules)
  const data = existsSync(dataDir) ? real(dataDir) : resolve(dataDir);
  if (inside(root, data)) throw new WorkspaceError("PROPRIX 데이터 폴더 안은 쓸 수 없습니다");
  return root;
}

// ---- 2) 경로 해석 ----

export interface Resolved {
  abs: string; // 실제 절대 경로
  rel: string; // 폴더 기준 상대 경로 ('/' 구분, 폴더 자신은 "")
  exists: boolean;
}

/** 폴더 안의 경로로 해석한다. 링크·정션은 따라간 실제 경로로 확인하고, 없는 파일은 가장 가까운 기존 상위 폴더로 확인 */
export function resolveInside(root: string, input: string): Resolved {
  const p = input.trim() === "" ? "." : input; // 앞뒤 공백을 지우지 않는다 (끝 공백 이름은 아래에서 거부)
  if (p.includes("\0")) throw new WorkspaceError("잘못된 경로");
  if (isUnc(p)) throw new WorkspaceError("네트워크·장치 경로는 쓸 수 없습니다");
  // Windows 는 이름 끝의 점·공백을 떼고 만든다 → "secret.pem." 이 *.pem 규칙을 피하지 못하게
  for (const seg of p.split(/[\\/]/))
    if (seg !== "." && seg !== ".." && /[. ]$/.test(seg))
      throw new WorkspaceError(`이름이 점·공백으로 끝납니다: ${seg}`);
  const realRoot = real(root);
  const abs = isAbsolute(p) ? resolve(p) : resolve(realRoot, p);
  if (abs.length > MAX_PATH) throw new WorkspaceError(`경로가 너무 깁니다 (${MAX_PATH}자 초과)`);
  // 드라이브 문자 뒤의 ':' 는 대체 데이터 스트림 (a.txt:stream)
  const tail = abs.slice(parse(abs).root.length);
  if (tail.includes(":")) throw new WorkspaceError("대체 데이터 스트림 경로는 쓸 수 없습니다");
  for (const seg of tail.split(/[\\/]/))
    if (seg && RESERVED.test(seg.split(".")[0] ?? "")) throw new WorkspaceError(`예약된 이름입니다: ${seg}`);

  let resolved: string;
  let exists = true;
  if (existsSync(abs)) resolved = real(abs);
  else {
    exists = false;
    let parent = abs;
    const rest: string[] = [];
    while (!existsSync(parent)) {
      const up = resolve(parent, "..");
      if (up === parent) throw new WorkspaceError("잘못된 경로");
      rest.unshift(parent.slice(up.length).replace(/^[\\/]/, ""));
      parent = up;
    }
    resolved = join(real(parent), ...rest);
  }
  if (!inside(resolved, realRoot)) throw new WorkspaceError("작업 폴더 밖의 경로입니다 (링크·정션 포함)");
  return { abs: resolved, rel: relative(realRoot, resolved).split(sep).join("/"), exists };
}

// ---- 3) 파일별 정책 ----

export type FileOp = "read" | "write" | "delete";

export interface WorkspaceRules {
  deny: string[]; // 읽기·쓰기 모두 막음
  readonly: string[]; // 쓰기·지우기만 막음
}
export const EMPTY_RULES: WorkspaceRules = { deny: [], readonly: [] };

// 기본 규칙 (끌 수 없음): 비밀·키·자격 증명은 읽기도 막고, .git 내부는 읽기만, node_modules 는 쓰지 않는다
const DEFAULT_DENY = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.pfx",
  "**/*.p12",
  "**/*.kdbx",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/.ssh/**",
  "**/credentials*",
  "**/secrets.*",
  "**/.npmrc",
  "**/.pypirc",
];
const DEFAULT_READONLY = ["**/.git/**", "**/.git", "**/node_modules/**"];

/** glob → 정규식 (대소문자 무시). `**` 는 여러 단계, `*`·`?` 는 한 단계 안. 패턴에 '/' 가 없으면 어느 단계 이름과도 비교 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replaceAll("\\", "/");
  const anywhere = !g.includes("/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(anywhere ? `(?:^|/)${re}$` : `^${re}$`, "i");
}

const matchAny = (rel: string, globs: string[]) => globs.some((g) => globToRegExp(g).test(rel));

export interface FileFacts {
  size?: number;
  binary?: boolean;
  readonlyAttr?: boolean;
}

export class WorkspacePolicy {
  constructor(private readonly rules: WorkspaceRules = EMPTY_RULES) {}

  /** 허용이면 null, 아니면 사유 */
  check(rel: string, op: FileOp, facts: FileFacts = {}): string | null {
    const path = rel || ".";
    if (matchAny(path, DEFAULT_DENY)) return "비밀·키·자격 증명 파일은 다룰 수 없습니다 (기본 규칙)";
    if (matchAny(path, this.rules.deny)) return "이 채팅의 규칙으로 막힌 파일입니다";
    if (op === "read") return null;
    if (matchAny(path, DEFAULT_READONLY)) return ".git·node_modules 안은 바꿀 수 없습니다 (기본 규칙)";
    if (matchAny(path, this.rules.readonly)) return "이 채팅의 규칙으로 읽기 전용인 파일입니다";
    if (facts.readonlyAttr) return "읽기 전용 속성 파일입니다";
    if (facts.binary) return "바이너리 파일은 바꿀 수 없습니다";
    if (op === "write" && (facts.size ?? 0) > MAX_WRITE_BYTES) return "5MB 넘는 파일은 바꿀 수 없습니다";
    return null;
  }
}

/** 파일 앞부분에 NUL 바이트가 있으면 바이너리로 본다 */
export function looksBinary(abs: string): boolean {
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(8000);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

export function factsOf(abs: string): FileFacts {
  if (!existsSync(abs)) return {};
  const st = statSync(abs);
  if (!st.isFile()) return {};
  return { size: st.size, binary: looksBinary(abs), readonlyAttr: (st.mode & 0o200) === 0 };
}

/** 작업 폴더 안에 있는 보호 폴더(PROPRIX 데이터 등)를 막는 규칙 */
export function protectedRules(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    const abs = existsSync(d) ? real(d) : resolve(d);
    if (!inside(abs, root) || lower(abs) === lower(root)) continue;
    const rel = relative(root, abs).split(sep).join("/");
    out.push(rel, `${rel}/**`);
  }
  return out;
}

export function parseRules(raw: string): WorkspaceRules {
  try {
    const v = JSON.parse(raw) as Partial<WorkspaceRules>;
    const list = (x: unknown) =>
      Array.isArray(x) ? x.filter((g): g is string => typeof g === "string" && g.trim() !== "").slice(0, 100) : [];
    return { deny: list(v.deny), readonly: list(v.readonly) };
  } catch {
    return EMPTY_RULES;
  }
}
