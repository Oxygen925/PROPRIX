// 백업 복구 (사용자 결정 2026-10-31): 화면에서 고르면 표시 파일만 남기고, 다음 시작 때 DB 를 열기 전에 바꾼다.
// 바꾸기 전 지금 상태(DB·표정·테마·사이트 계정 비밀 파일)를 backups/before-restore 에 한 벌 남겨 되돌릴 수 있게 한다.
// 시작 때 siteAccounts.prune() 이 DB 에 없는 계정의 비밀 파일을 지우므로 auth/site 도 사본에 넣는다.
// 일반 백업에 없는 폴더는 지금 것을 그대로 둔다 (-files 도입 전 백업, Skill 폴더). 로그인 정보(auth/)는 건드리지 않는다.
// 중간에 죽어도 다시 시작하면 이어 간다: 사본을 다 만들기 전에는 지금 데이터가 그대로고, 만든 뒤에는 사본을 덮어쓰지 않는다
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BEFORE_RESTORE } from "@proprix/shared";
import { filesDir, isBackupName } from "./backup";
import { latestMigration } from "./db";

const DB = "proprix.sqlite";
const MARKER = "restore-pending.json";
const RESULT = "restore-result.json";
const META = "meta.json";
const SITE = "auth-site"; // 사본 안에서 auth/site 의 이름
const WAL = ["-wal", "-shm"];

interface Marker {
  name: string;
  saved?: boolean; // 복구 전 사본을 다 만들었다
}

export interface RestoreOutcome {
  ok: boolean;
  name: string;
  at: number;
  error: string;
}

export interface RestoreState {
  pending: string | null;
  before: { at: number; from: string } | null; // 되돌릴 수 있는 복구 전 상태
  result: RestoreOutcome | null; // 아직 알리지 않은 지난 복구의 결과
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const backupsDir = (dataDir: string) => join(dataDir, "backups");
const sourceDb = (dataDir: string, name: string) =>
  name === BEFORE_RESTORE ? join(backupsDir(dataDir), BEFORE_RESTORE, DB) : join(backupsDir(dataDir), name);

// 복구해도 되는 DB 인가. 괜찮으면 null, 아니면 화면에 보일 이유
export function checkBackupDb(path: string, latest = latestMigration()): string | null {
  if (!existsSync(path)) return "백업 파일이 없습니다";
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const check = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    if (check?.integrity_check !== "ok") return "백업 파일이 손상됐습니다";
    const row = db.query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM schema_migrations").get();
    if ((row?.id ?? 0) > latest) return "더 새로운 버전의 앱에서 만든 백업입니다. 앱을 업데이트한 뒤 복구하세요";
    return null;
  } catch {
    return "백업 파일을 읽지 못했습니다";
  } finally {
    db?.close();
  }
}

// ---- 화면에서 부르는 쪽 ----

export function restoreState(dataDir: string): RestoreState {
  return {
    pending: readJson<Marker>(join(dataDir, MARKER))?.name ?? null,
    before: readJson<{ at: number; from: string }>(join(backupsDir(dataDir), BEFORE_RESTORE, META)),
    result: readJson<RestoreOutcome>(join(dataDir, RESULT)),
  };
}

/** 다음 시작 때 복구하도록 표시한다. 괜찮으면 null, 아니면 이유 */
export function requestRestore(dataDir: string, name: string, latest = latestMigration()): string | null {
  if (name !== BEFORE_RESTORE && !isBackupName(name)) return "없는 백업입니다";
  const problem = checkBackupDb(sourceDb(dataDir, name), latest);
  if (problem) return problem;
  writeFileSync(join(dataDir, MARKER), JSON.stringify({ name } satisfies Marker));
  return null;
}

export function cancelRestore(dataDir: string) {
  rmSync(join(dataDir, MARKER), { force: true });
}

export function clearRestoreResult(dataDir: string) {
  rmSync(join(dataDir, RESULT), { force: true });
}

// ---- 시작할 때 (DB 를 열기 전) ----

function copyInto(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

// 지금 상태를 dir 에 저장한다. DB 가 손상돼 VACUUM 이 안 되면 파일 그대로 복사한다
function saveCurrent(dataDir: string, dir: string, from: string, now: number) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const current = join(dataDir, DB);
  if (existsSync(current)) {
    try {
      const db = new Database(current, { readonly: true });
      try {
        db.query("VACUUM INTO $dst").run({ $dst: join(dir, DB) });
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn("[restore] VACUUM 실패 — 파일을 그대로 복사", err);
      rmSync(join(dir, DB), { force: true });
      for (const suffix of ["", "-wal"])
        if (existsSync(current + suffix)) copyInto(current + suffix, join(dir, DB + suffix));
    }
  }
  for (const sub of ["characters", "themes"])
    if (existsSync(join(dataDir, sub))) copyInto(join(dataDir, sub), join(dir, sub));
  const site = join(dataDir, "auth", "site");
  if (existsSync(site)) copyInto(site, join(dir, SITE));
  writeFileSync(join(dir, META), JSON.stringify({ at: now, from }));
}

// 폴더 하나를 from 의 내용으로 바꾼다. 복사를 끝낸 뒤 바꾸므로 복사가 실패하면 지금 폴더가 남는다
function replaceDir(from: string, to: string, exact: boolean) {
  const has = existsSync(from);
  if (!has && !exact) return;
  const tmp = `${to}.restore-tmp`;
  rmSync(tmp, { recursive: true, force: true });
  if (has) copyInto(from, tmp);
  rmSync(to, { recursive: true, force: true });
  if (has) renameSync(tmp, to);
}

// exact: 사본에 없는 폴더는 지운다 (복구 전 상태로 정확히 되돌릴 때). 아니면 지금 것을 둔다
function install(dataDir: string, db: string, files: string, site: string | null, exact: boolean) {
  const tmp = join(dataDir, `${DB}.restore-tmp`);
  rmSync(tmp, { force: true });
  copyInto(db, tmp);
  // 사본이 손상 DB 를 그대로 복사한 것이면 WAL 도 함께 옮긴다
  const wal = existsSync(`${db}-wal`) ? `${tmp}-wal` : null;
  if (wal) copyInto(`${db}-wal`, wal);
  for (const suffix of WAL) rmSync(join(dataDir, DB + suffix), { force: true });
  renameSync(tmp, join(dataDir, DB));
  if (wal) renameSync(wal, join(dataDir, `${DB}-wal`));
  for (const sub of ["characters", "themes"]) replaceDir(join(files, sub), join(dataDir, sub), exact);
  if (site) replaceDir(site, join(dataDir, "auth", "site"), exact);
}

/** 표시가 있으면 복구한다. 실패해도 예외를 던지지 않고 결과를 남긴다 (앱은 지금 데이터로 뜬다) */
export function applyPendingRestore(
  dataDir: string,
  now: () => number = Date.now,
  latest = latestMigration(),
): RestoreOutcome | null {
  const markerPath = join(dataDir, MARKER);
  const marker = readJson<Marker>(markerPath);
  if (!marker) {
    rmSync(markerPath, { force: true });
    return null;
  }
  const { name } = marker;
  const safety = join(backupsDir(dataDir), BEFORE_RESTORE);
  const held = `${safety}.src`; // 되돌릴 때 원본 사본을 잠시 옮겨 둔다
  const tmp = `${safety}.tmp`;
  const undo = name === BEFORE_RESTORE;
  const finish = (error: string): RestoreOutcome => {
    const outcome = { ok: !error, name, at: now(), error };
    writeFileSync(join(dataDir, RESULT), JSON.stringify(outcome));
    rmSync(markerPath, { force: true });
    console.log(error ? `[restore] 실패: ${error}` : `[restore] ${name} 복구함`);
    return outcome;
  };
  try {
    if (!undo && !isBackupName(name)) return finish("없는 백업입니다");
    const root = undo ? (existsSync(held) ? held : safety) : null;
    if (!marker.saved) {
      const problem = checkBackupDb(root ? join(root, DB) : sourceDb(dataDir, name), latest);
      if (problem) return finish(problem);
      saveCurrent(dataDir, tmp, name, now());
      if (undo && !existsSync(held)) renameSync(safety, held);
      rmSync(safety, { recursive: true, force: true });
      renameSync(tmp, safety);
      writeFileSync(markerPath, JSON.stringify({ name, saved: true } satisfies Marker));
    }
    const src = undo
      ? { db: join(held, DB), files: held, site: join(held, SITE) }
      : {
          db: sourceDb(dataDir, name),
          files: join(backupsDir(dataDir), filesDir(name)),
          site: null,
        };
    try {
      install(dataDir, src.db, src.files, src.site, undo);
    } catch (err) {
      // 바꾸다 실패하면 방금 저장한 상태로 돌린다
      console.error("[restore] 교체 실패 — 복구 전 상태로 돌림", err);
      install(dataDir, join(safety, DB), safety, join(safety, SITE), true);
      throw err;
    }
    rmSync(held, { recursive: true, force: true });
    return finish("");
  } catch (err) {
    // 사본을 바꾸는 중에 실패했으면 옮겨 둔 원본을 제자리로
    if (existsSync(held) && !existsSync(safety)) renameSync(held, safety);
    return finish(err instanceof Error ? err.message : String(err));
  }
}
