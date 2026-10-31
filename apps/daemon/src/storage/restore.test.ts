import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEFORE_RESTORE } from "@proprix/shared";
import { BackupService } from "./backup";
import { latestMigration, openDb } from "./db";
import { applyPendingRestore, cancelRestore, requestRestore, restoreState } from "./restore";

let root: string;
const dbPath = () => join(root, "proprix.sqlite");
const write = (rel: string, text: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// 지금 상태: settings 표에 값 하나를 넣어 어느 DB 인지 구분한다
function setValue(value: string) {
  const db = openDb(dbPath());
  db.query("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('mark', $value, 0)").run({ value });
  db.close(true);
}
function value() {
  const db = openDb(dbPath());
  const row = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'mark'").get();
  db.close(true);
  return row?.value;
}
function makeBackup(): string {
  const db = openDb(dbPath());
  const b = new BackupService(db, join(root, "backups"), () => ({ enabled: true, keep: 7 }), Date.now, [
    join(root, "characters"),
    join(root, "themes"),
  ]);
  const { name } = b.runNow();
  db.close(true);
  return name;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "proprix-restore-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("복구: DB·표정·테마를 백업 시점으로, 비밀 파일은 그대로, 지금 상태는 사본으로 남는다", () => {
  setValue("백업 때");
  write("characters/p1/smile.png", "옛 표정");
  const name = makeBackup();

  setValue("지금");
  write("characters/p1/smile.png", "새 표정");
  write("characters/p2/new.png", "새 페르소나");
  write("themes/t1/theme.css", "새 테마");
  write("auth/site/a1.bin", "비밀");
  write("auth/siwc.bin", "로그인");

  expect(requestRestore(root, name)).toBeNull();
  expect(restoreState(root).pending).toBe(name);
  expect(value()).toBe("지금"); // 표시만 한다

  const out = applyPendingRestore(root, () => 123);
  expect(out).toEqual({ ok: true, name, at: 123, error: "" });
  expect(value()).toBe("백업 때");
  expect(read("characters/p1/smile.png")).toBe("옛 표정");
  expect(existsSync(join(root, "characters/p2"))).toBe(false);
  expect(read("themes/t1/theme.css")).toBe("새 테마"); // 백업에 테마가 없으면 지금 것을 둔다
  expect(read("auth/site/a1.bin")).toBe("비밀");
  expect(read("auth/siwc.bin")).toBe("로그인");

  const state = restoreState(root);
  expect(state.pending).toBeNull();
  expect(state.before).toEqual({ at: 123, from: name });
  expect(state.result?.ok).toBe(true);
  expect(applyPendingRestore(root)).toBeNull(); // 한 번만
});

test("되돌리기: 복구 직전 상태로 정확히 돌아가고, 다시 되돌릴 수 있다", () => {
  setValue("백업 때");
  write("characters/p1/smile.png", "옛 표정");
  const name = makeBackup();
  setValue("지금");
  write("characters/p1/smile.png", "새 표정");
  write("auth/site/a1.bin", "비밀");
  requestRestore(root, name);
  applyPendingRestore(root);
  // 시작 때 prune 이 DB 에 없는 계정의 비밀 파일을 지운 상황
  rmSync(join(root, "auth/site/a1.bin"));
  write("themes/t1/theme.css", "복구 뒤에 넣은 테마");

  expect(requestRestore(root, BEFORE_RESTORE)).toBeNull();
  expect(applyPendingRestore(root)?.ok).toBe(true);
  expect(value()).toBe("지금");
  expect(read("characters/p1/smile.png")).toBe("새 표정");
  expect(read("auth/site/a1.bin")).toBe("비밀");
  expect(existsSync(join(root, "themes"))).toBe(false); // 사본에 없던 폴더는 지운다
  expect(existsSync(join(root, "backups", `${BEFORE_RESTORE}.src`))).toBe(false);

  expect(requestRestore(root, BEFORE_RESTORE)).toBeNull();
  expect(applyPendingRestore(root)?.ok).toBe(true);
  expect(value()).toBe("백업 때");
});

test("사본 뒤에 죽어도 다시 시작하면 이어 가고, 사본을 덮어쓰지 않는다", () => {
  setValue("백업 때");
  const name = makeBackup();
  setValue("지금");
  requestRestore(root, name);
  applyPendingRestore(root);
  // 사본을 다 만들고 교체하다 죽은 상황: 표시가 saved 로 남아 있고 DB 는 이미 다른 내용
  setValue("반쯤 교체됨");
  writeFileSync(join(root, "restore-pending.json"), JSON.stringify({ name, saved: true }));
  expect(applyPendingRestore(root)?.ok).toBe(true);
  expect(value()).toBe("백업 때");
  requestRestore(root, BEFORE_RESTORE);
  applyPendingRestore(root);
  expect(value()).toBe("지금");
});

test("거절: 잘못된 이름·경로, 없는 파일, 손상, 더 새로운 버전", () => {
  setValue("지금");
  mkdirSync(join(root, "backups"), { recursive: true });
  expect(requestRestore(root, "../proprix.sqlite")).toBe("없는 백업입니다");
  expect(requestRestore(root, "proprix-20260101-000000.sqlite")).toBe("백업 파일이 없습니다");
  expect(requestRestore(root, BEFORE_RESTORE)).toBe("백업 파일이 없습니다");

  const broken = "proprix-20260101-000001.sqlite";
  writeFileSync(join(root, "backups", broken), "sqlite 가 아닌 내용");
  expect(requestRestore(root, broken)).toBe("백업 파일을 읽지 못했습니다");

  const newer = makeBackup();
  expect(requestRestore(root, newer, latestMigration() - 1)).toContain("더 새로운 버전");
  expect(restoreState(root).pending).toBeNull();
});

test("시작 때 파일이 없어졌으면 실패를 남기고 지금 데이터로 뜬다", () => {
  setValue("백업 때");
  const name = makeBackup();
  setValue("지금");
  requestRestore(root, name);
  rmSync(join(root, "backups", name));

  const out = applyPendingRestore(root);
  expect(out?.ok).toBe(false);
  expect(out?.error).toBe("백업 파일이 없습니다");
  expect(value()).toBe("지금");
  expect(restoreState(root).pending).toBeNull();
  expect(restoreState(root).before).toBeNull(); // 사본도 만들지 않는다
});

test("교체하다 실패하면 복구 전 상태로 돌린다", () => {
  setValue("백업 때");
  write("characters/p1/smile.png", "옛 표정");
  const name = makeBackup();
  setValue("지금");
  write("characters/p1/smile.png", "새 표정");
  requestRestore(root, name);
  applyPendingRestore(root);
  // 사본을 만든 뒤 교체하다 죽고, 다시 시작했더니 백업 파일이 없어진 상황
  setValue("반쯤 교체됨");
  write("characters/p1/smile.png", "반쯤 교체된 표정");
  writeFileSync(join(root, "restore-pending.json"), JSON.stringify({ name, saved: true }));
  rmSync(join(root, "backups", name));

  const out = applyPendingRestore(root);
  expect(out?.ok).toBe(false);
  expect(value()).toBe("지금");
  expect(read("characters/p1/smile.png")).toBe("새 표정");
  expect(restoreState(root).pending).toBeNull();
});

test("취소하면 다음 시작에 아무 일도 없다", () => {
  setValue("백업 때");
  const name = makeBackup();
  setValue("지금");
  requestRestore(root, name);
  cancelRestore(root);
  expect(applyPendingRestore(root)).toBeNull();
  expect(value()).toBe("지금");
});

test("옛 백업: 마이그레이션이 덜 된 DB 도 복구되고 열 때 올라간다", () => {
  setValue("지금");
  mkdirSync(join(root, "backups"), { recursive: true });
  const old = "proprix-20200101-000000.sqlite";
  const db = new Database(join(root, "backups", old), { create: true });
  db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  db.close();
  expect(requestRestore(root, old)).toBeNull();
  expect(applyPendingRestore(root)?.ok).toBe(true);
  const opened = openDb(dbPath());
  const row = opened.query<{ id: number }, []>("SELECT MAX(id) AS id FROM schema_migrations").get();
  opened.close(true);
  expect(row?.id).toBe(latestMigration());
});
