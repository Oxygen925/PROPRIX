// 작업 폴더 파일 도구 (P7a)
// - 읽기: 목록·읽기·찾기 (정책으로 막힌 파일은 보이지 않거나 거부)
// - 쓰기: 승인 전에 바뀔 내용을 확정하고 diff·해시를 만든다(prepare). 승인 뒤에는 파일이 그때 그대로일 때만
//   그 내용을 그대로 쓴다(apply — TOCTOU 방지). 바꾸기 직전 원본을 snapshots/ 에 두고 file_changes 에 남긴다(복구)
// - 글자: UTF-8 만 고친다 (CP949 등은 한글이 깨지므로 거부). BOM 과 CRLF 줄바꿈은 원래대로 지킨다
import type { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { factsOf, looksBinary, type Resolved, resolveInside, WorkspaceError, type WorkspacePolicy } from "./workspace";

export interface Workspace {
  root: string;
  policy: WorkspacePolicy;
  shell: boolean; // 방에서 명령 실행을 켰는가
}

export const PREVIEW_MAX = 200_000; // 승인 카드 diff 전체 (화면은 앞부분만 보이고 '전체 보기'로 펼친다. 넘으면 잘림 표시)
const READ_MAX_BYTES = 2 * 1024 * 1024;
const LIST_MAX = 500;
const SEARCH_MAX = 200;
const SEARCH_FILES_MAX = 5000;
const SEARCH_FILE_BYTES = 1024 * 1024;
const SEARCH_TOTAL_BYTES = 50 * 1024 * 1024; // 찾기 한 번에 읽는 양 (daemon 이 멈추지 않게)
const SEARCH_LINE_MAX = 2000; // 이보다 긴 줄은 건너뛴다 (정규식이 오래 걸리지 않게)
const SEARCH_REGEX_MAX = 200;
const SKIP_DIRS = new Set(["node_modules", ".git", ".svelte-kit", "dist", "build", "target", ".venv", "__pycache__"]);
const BOM = "﻿";

export const sha256 = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
const fileHash = (abs: string) => (existsSync(abs) ? sha256(readFileSync(abs)) : "");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** UTF-8 로 읽는다 (BOM 은 떼어 따로). UTF-8 이 아니면 WorkspaceError */
export function readUtf8(abs: string): { text: string; bom: boolean } {
  let text: string;
  try {
    text = utf8.decode(readFileSync(abs));
  } catch {
    throw new WorkspaceError("UTF-8 이 아닌 파일입니다 (CP949 등은 글자가 깨질 수 있어 다루지 않습니다)");
  }
  return text.startsWith(BOM) ? { text: text.slice(1), bom: true } : { text, bom: false };
}

const usesCrlf = (text: string) => text.includes("\r\n") && !text.replace(/\r\n/g, "").includes("\n");
const toCrlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

function deny(ws: Workspace, r: Resolved, op: "read" | "write" | "delete") {
  const why = ws.policy.check(r.rel, op, factsOf(r.abs));
  if (why) throw new WorkspaceError(why);
}

// ---- 읽기 ----

export function listFiles(ws: Workspace, path: string, depth: number) {
  const base = resolveInside(ws.root, path);
  if (!base.exists || !statSync(base.abs).isDirectory()) throw new WorkspaceError("없는 폴더입니다");
  const out: { path: string; type: "file" | "dir"; size?: number }[] = [];
  let truncated = false;
  const walk = (dir: string, rel: string, level: number) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= LIST_MAX) {
        truncated = true;
        return;
      }
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (ws.policy.check(childRel, "read")) continue; // 막힌 파일은 목록에도 보이지 않는다
      if (e.isDirectory()) {
        out.push({ path: childRel, type: "dir" });
        if (level < depth && !SKIP_DIRS.has(e.name)) walk(join(dir, e.name), childRel, level + 1);
      } else if (e.isFile()) out.push({ path: childRel, type: "file", size: statSync(join(dir, e.name)).size });
    }
  };
  walk(base.abs, base.rel, 1);
  return { path: base.rel || ".", entries: out, truncated };
}

export function readText(ws: Workspace, path: string, offset: number, limit: number) {
  const r = resolveInside(ws.root, path);
  if (!r.exists || !statSync(r.abs).isFile()) throw new WorkspaceError("없는 파일입니다");
  deny(ws, r, "read");
  if (statSync(r.abs).size > READ_MAX_BYTES) throw new WorkspaceError("2MB 넘는 파일은 읽을 수 없습니다");
  if (looksBinary(r.abs)) throw new WorkspaceError("바이너리 파일은 읽을 수 없습니다");
  const lines = readUtf8(r.abs).text.split(/\r?\n/);
  const from = Math.max(1, offset);
  const to = Math.min(lines.length, from + Math.min(Math.max(limit, 1), 2000) - 1);
  return {
    path: r.rel,
    total_lines: lines.length,
    from,
    to,
    content: lines
      .slice(from - 1, to)
      .map((l, i) => `${from + i}\t${l}`)
      .join("\n"),
  };
}

// 중첩 반복(예: (a+)+) 은 되돌아가기가 폭발할 수 있어 받지 않는다
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/;

export function searchText(ws: Workspace, query: string, path: string, glob: string | null, regex: boolean) {
  const base = resolveInside(ws.root, path);
  if (!base.exists || !statSync(base.abs).isDirectory()) throw new WorkspaceError("없는 폴더입니다");
  let re: RegExp;
  if (regex) {
    if (query.length > SEARCH_REGEX_MAX) throw new WorkspaceError(`정규식은 ${SEARCH_REGEX_MAX}자까지입니다`);
    if (NESTED_QUANTIFIER.test(query)) throw new WorkspaceError("반복을 겹친 정규식((a+)+ 등)은 쓸 수 없습니다");
  }
  try {
    re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  } catch {
    throw new WorkspaceError("잘못된 정규식입니다");
  }
  const nameRe = glob
    ? new RegExp(
        `^${glob
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replaceAll("*", ".*")
          .replaceAll("?", ".")}$`,
        "i",
      )
    : null;
  const matches: { path: string; line: number; text: string }[] = [];
  let files = 0;
  let bytes = 0;
  const full = () => matches.length >= SEARCH_MAX || files >= SEARCH_FILES_MAX || bytes >= SEARCH_TOTAL_BYTES;
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (full()) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (ws.policy.check(childRel, "read")) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs, childRel);
        continue;
      }
      if (!e.isFile() || (nameRe && !nameRe.test(e.name))) continue;
      files++;
      const size = statSync(abs).size;
      if (size > SEARCH_FILE_BYTES || looksBinary(abs)) continue;
      bytes += size;
      let text: string;
      try {
        text = readUtf8(abs).text;
      } catch {
        continue; // UTF-8 이 아닌 파일은 건너뛴다
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < SEARCH_MAX; i++) {
        const line = lines[i] as string;
        if (line.length <= SEARCH_LINE_MAX && re.test(line))
          matches.push({ path: childRel, line: i + 1, text: line.trim().slice(0, 300) });
      }
    }
  };
  walk(base.abs, base.rel);
  return { matches, truncated: full() };
}

// ---- 쓰기: 준비(승인 전) → 적용(승인 뒤) ----

export interface PreparedChange {
  op: "write" | "edit" | "delete";
  root: string;
  abs: string;
  rel: string;
  beforeHash: string; // '' = 새 파일
  after: string | null; // 디스크에 쓸 그대로의 내용 (BOM·줄바꿈 포함, 지우기는 null)
  afterHash: string; // '' = 지움
  preview: string;
}

function diffPreview(rel: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before, after, "", "", { context: 3 });
  const body = patch.split("\n").slice(2).join("\n"); // 맨 앞 구분선 두 줄은 뺀다
  return body.length > PREVIEW_MAX ? `${body.slice(0, PREVIEW_MAX)}\n…(미리보기 잘림)` : body;
}

const finalText = (text: string, bom: boolean) => (bom ? BOM + text : text);

export function prepareWrite(ws: Workspace, path: string, content: string): PreparedChange {
  const r = resolveInside(ws.root, path);
  if (r.exists && !statSync(r.abs).isFile()) throw new WorkspaceError("폴더에는 쓸 수 없습니다");
  deny(ws, r, "write");
  if (Buffer.byteLength(content) > 5 * 1024 * 1024) throw new WorkspaceError("5MB 넘는 내용은 쓸 수 없습니다");
  const old = r.exists ? readUtf8(r.abs) : { text: "", bom: false };
  // 기존 파일이 CRLF 면 새 내용도 CRLF 로 (모든 줄이 바뀐 것처럼 보이지 않게)
  const text = r.exists && usesCrlf(old.text) ? toCrlf(content) : content;
  const after = finalText(text, old.bom);
  return {
    op: "write",
    root: ws.root,
    abs: r.abs,
    rel: r.rel,
    beforeHash: r.exists ? fileHash(r.abs) : "",
    after,
    afterHash: sha256(after),
    preview: diffPreview(r.rel, old.text, text),
  };
}

export function prepareEdit(
  ws: Workspace,
  path: string,
  oldText: string,
  newText: string,
  all: boolean,
): PreparedChange {
  const r = resolveInside(ws.root, path);
  if (!r.exists || !statSync(r.abs).isFile()) throw new WorkspaceError("없는 파일입니다");
  deny(ws, r, "write");
  if (!oldText) throw new WorkspaceError("바꿀 글이 비었습니다");
  const { text: before, bom } = readUtf8(r.abs);
  let find = oldText;
  let replace = newText;
  let count = before.split(find).length - 1;
  // 모델은 LF 로 읽으므로 CRLF 파일이면 CRLF 로 바꿔 다시 찾는다
  if (count === 0 && before.includes("\r\n")) {
    find = toCrlf(oldText);
    replace = toCrlf(newText);
    count = before.split(find).length - 1;
  }
  if (count === 0) throw new WorkspaceError("바꿀 글을 찾지 못했습니다 (공백·줄바꿈까지 똑같아야 함)");
  if (count > 1 && !all)
    throw new WorkspaceError(`바꿀 글이 ${count}곳에 있습니다. 더 길게 지정하거나 replace_all 을 쓰세요`);
  const text = all ? before.split(find).join(replace) : before.replace(find, () => replace);
  const after = finalText(text, bom);
  return {
    op: "edit",
    root: ws.root,
    abs: r.abs,
    rel: r.rel,
    beforeHash: fileHash(r.abs),
    after,
    afterHash: sha256(after),
    preview: diffPreview(r.rel, before, text),
  };
}

export function prepareDelete(ws: Workspace, path: string): PreparedChange {
  const r = resolveInside(ws.root, path);
  if (!r.exists || !statSync(r.abs).isFile()) throw new WorkspaceError("없는 파일입니다 (폴더는 삭제할 수 없음)");
  deny(ws, r, "delete");
  const st = statSync(r.abs);
  return {
    op: "delete",
    root: ws.root,
    abs: r.abs,
    rel: r.rel,
    beforeHash: fileHash(r.abs),
    after: null,
    afterHash: "",
    preview: `삭제: ${r.rel}\n크기 ${st.size} 바이트 · 마지막 수정 ${new Date(st.mtimeMs).toLocaleString("ko-KR")}\n(원본은 복구 보관함으로 옮겨져 되돌릴 수 있습니다)`,
  };
}

// ---- 복구 기록 ----

export interface FileChange {
  id: string;
  callId: string; // 되돌리기로 생긴 기록은 "restore:<원래 기록 id>"
  roomId: string;
  path: string;
  op: "write" | "edit" | "delete";
  size: number;
  createdAt: number;
  restoredAt: number | null;
}

interface ChangeRow {
  id: string;
  call_id: string;
  room_id: string;
  path: string;
  op: FileChange["op"];
  before_hash: string;
  after_hash: string;
  snapshot: string;
  size: number;
  created_at: number;
  restored_at: number | null;
}

const toChange = (r: ChangeRow): FileChange => ({
  id: r.id,
  callId: r.call_id,
  roomId: r.room_id,
  path: r.path,
  op: r.op,
  size: r.size,
  createdAt: r.created_at,
  restoredAt: r.restored_at,
});

export type RestoreResult = "ok" | "conflict" | "not_found" | "already" | "missing_snapshot";

export class FileChangeStore {
  constructor(
    private readonly db: Database,
    readonly dir: string, // <dataDir>/snapshots
    private readonly now: () => number = Date.now,
    private readonly onChange: (roomId: string) => void = () => {},
  ) {}

  /**
   * 승인 뒤 적용: 정책을 다시 보고, 파일이 미리보기 때 그대로인지 해시로 확인한 다음 원본을 보관하고 바꾼다.
   * 바뀌어 있으면 WorkspaceError (모델에 "다시 요청" 으로 전해진다)
   */
  apply(ws: Workspace, p: PreparedChange, callId: string, roomId: string): FileChange {
    const r = resolveInside(ws.root, p.rel);
    if (r.abs.toLowerCase() !== p.abs.toLowerCase()) throw new WorkspaceError("경로가 바뀌었습니다. 다시 요청하세요");
    deny(ws, r, p.op === "delete" ? "delete" : "write");
    if (fileHash(r.abs) !== p.beforeHash)
      throw new WorkspaceError("승인한 뒤 파일이 바뀌었습니다. 다시 읽고 요청하세요");
    const change = this.change({ root: p.root, rel: p.rel, abs: r.abs, op: p.op, after: p.after }, callId, roomId);
    this.onChange(roomId);
    return change;
  }

  /** 사용자가 직접 저장 (승인 없이 바로). 이미 있는 파일은 overwrite 없이는 "exists" — 덮어써도 원본은 보관된다 */
  save(
    ws: Workspace,
    path: string,
    content: string,
    callId: string,
    roomId: string,
    overwrite = false,
  ): FileChange | "exists" {
    const p = prepareWrite(ws, path, content);
    if (p.beforeHash && !overwrite) return "exists";
    return this.apply(ws, p, callId, roomId);
  }

  /**
   * 원본을 보관하고 바꾼 뒤 기록한다 (적용·되돌리기 공통). after = null 이면 지운다 (실제로는 보관함으로 옮김).
   * 되돌리기도 이 길을 지나므로 되돌리기 자체를 다시 되돌릴 수 있다 — 어떤 경우에도 파일을 그냥 지우지 않는다
   */
  private change(
    t: { root: string; rel: string; abs: string; op: FileChange["op"]; after: string | Buffer | null },
    callId: string,
    roomId: string,
  ): FileChange {
    const id = crypto.randomUUID();
    const snapDir = join(this.dir, roomId, id);
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(join(snapDir, "meta.json"), JSON.stringify({ root: t.root, rel: t.rel }));
    const beforeHash = fileHash(t.abs);
    let size = 0;
    if (beforeHash) {
      size = statSync(t.abs).size;
      if (t.after === null) renameSync(t.abs, join(snapDir, "original"));
      else copyFileSync(t.abs, join(snapDir, "original"));
    }
    if (t.after !== null) {
      mkdirSync(dirname(t.abs), { recursive: true });
      writeFileSync(t.abs, t.after);
    }
    const row: ChangeRow = {
      id,
      call_id: callId,
      room_id: roomId,
      path: t.rel,
      op: t.op,
      before_hash: beforeHash,
      after_hash: t.after === null ? "" : sha256(t.after),
      snapshot: [roomId, id].join("/"),
      size,
      created_at: this.now(),
      restored_at: null,
    };
    this.db
      .query(
        `INSERT INTO file_changes (id, call_id, room_id, path, op, before_hash, after_hash, snapshot, size, created_at)
         VALUES ($id, $call, $room, $path, $op, $before, $after, $snap, $size, $at)`,
      )
      .run({
        id,
        call: callId,
        room: roomId,
        path: t.rel,
        op: t.op,
        before: row.before_hash,
        after: row.after_hash,
        snap: row.snapshot,
        size,
        at: row.created_at,
      });
    return toChange(row);
  }

  // 감사 로그: 여러 호출의 변경을 한 번에
  forCalls(callIds: readonly string[]): FileChange[] {
    if (callIds.length === 0) return [];
    const params = Object.fromEntries(callIds.map((id, i) => [`c${i}`, id]));
    return this.db
      .query<ChangeRow, Record<string, string>>(
        `SELECT * FROM file_changes WHERE call_id IN (${callIds.map((_, i) => `$c${i}`).join(", ")}) ORDER BY created_at`,
      )
      .all(params)
      .map(toChange);
  }

  forRoom(roomId: string): FileChange[] {
    return this.db
      .query<ChangeRow, { room: string }>("SELECT * FROM file_changes WHERE room_id = $room ORDER BY created_at")
      .all({ room: roomId })
      .map(toChange);
  }

  /** 원본으로 되돌린다. 그 뒤 파일이 또 바뀌었으면 force 없이는 conflict. 지금 내용은 보관함에 남는다 */
  restore(id: string, force: boolean): RestoreResult {
    const r = this.db.query<ChangeRow, { id: string }>("SELECT * FROM file_changes WHERE id = $id").get({ id });
    if (!r) return "not_found";
    if (r.restored_at) return "already";
    if (!r.snapshot) return "missing_snapshot";
    const snapDir = join(this.dir, ...r.snapshot.split("/"));
    let meta: { root: string; rel: string };
    try {
      meta = JSON.parse(readFileSync(join(snapDir, "meta.json"), "utf8"));
    } catch {
      return "missing_snapshot";
    }
    const abs = join(meta.root, ...meta.rel.split("/"));
    if (!force && fileHash(abs) !== r.after_hash) return "conflict";
    const original = join(snapDir, "original");
    if (r.before_hash && !existsSync(original)) return "missing_snapshot";
    const after = r.before_hash ? readFileSync(original) : null; // 새로 만든 파일을 되돌리면 지운다 (보관함으로)
    if (after === null && !existsSync(abs)) {
      // 이미 없으면 할 일 없음
    } else
      this.change(
        { root: meta.root, rel: meta.rel, abs, op: after === null ? "delete" : "write", after },
        `restore:${id}`,
        r.room_id,
      );
    this.db.query("UPDATE file_changes SET restored_at = $at WHERE id = $id").run({ id, at: this.now() });
    this.onChange(r.room_id);
    return "ok";
  }

  /** 보관 기간·용량을 넘는 보관본과 지운 방의 보관본을 지운다 (오래된 것부터) */
  prune(maxAgeMs = 30 * 24 * 60 * 60 * 1000, maxBytesPerRoom = 500 * 1024 * 1024) {
    const rows = this.db
      .query<ChangeRow, []>("SELECT * FROM file_changes WHERE snapshot != '' ORDER BY created_at DESC")
      .all();
    const used = new Map<string, number>();
    for (const r of rows) {
      const total = (used.get(r.room_id) ?? 0) + r.size;
      used.set(r.room_id, total);
      if (this.now() - r.created_at > maxAgeMs || total > maxBytesPerRoom) this.drop(r);
    }
    // 방이 지워지면 기록은 함께 지워지지만 폴더는 남는다
    let rooms: string[] = [];
    try {
      rooms = readdirSync(this.dir);
    } catch {
      return;
    }
    const exists = this.db.query<{ n: number }, { id: string }>("SELECT COUNT(*) AS n FROM rooms WHERE id = $id");
    for (const room of rooms)
      if (!exists.get({ id: room })?.n) rmSync(join(this.dir, room), { recursive: true, force: true });
  }

  usage(): { bytes: number; count: number } {
    const r = this.db
      .query<{ bytes: number | null; count: number }, []>(
        "SELECT SUM(size) AS bytes, COUNT(*) AS count FROM file_changes WHERE snapshot != ''",
      )
      .get();
    return { bytes: r?.bytes ?? 0, count: r?.count ?? 0 };
  }

  clear() {
    for (const r of this.db.query<ChangeRow, []>("SELECT * FROM file_changes WHERE snapshot != ''").all()) this.drop(r);
  }

  private drop(r: ChangeRow) {
    rmSync(join(this.dir, ...r.snapshot.split("/")), { recursive: true, force: true });
    this.db.query("UPDATE file_changes SET snapshot = '', size = 0 WHERE id = $id").run({ id: r.id });
  }
}
