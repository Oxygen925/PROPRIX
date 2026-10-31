// 자동 백업: 하루 한 번 데이터 폴더의 backups/ 에 DB 사본을 만들고 최근 keep 개만 남긴다 (사용자 결정 2026-10-29)
// VACUUM INTO 는 읽기 트랜잭션으로 일관된 사본을 만든다 (쓰기 중이어도 안전). 로그인 정보(auth/)는 DB 밖이라 들어가지 않는다
// DB 밖의 표정·테마 파일은 같은 이름의 -files 폴더에 함께 복사하고 함께 지운다. 파일 복사가 실패해도 DB 사본은 남긴다
import type { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { BackupSettings } from "@proprix/shared";

const DAY = 24 * 60 * 60 * 1000;
const CHECK_EVERY = 60 * 60 * 1000;
const NAME = /^proprix-\d{8}-\d{6}\.sqlite$/;

export interface BackupItem {
  name: string;
  size: number;
  at: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const isBackupName = (name: string) => NAME.test(name);
export const filesDir = (name: string) => name.replace(/\.sqlite$/, "-files");
const stamp = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

export class BackupService {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Database,
    readonly dir: string,
    private readonly settings: () => BackupSettings,
    private readonly now: () => number = Date.now,
    private readonly files: readonly string[] = [],
  ) {}

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), CHECK_EVERY);
  }

  stop() {
    clearInterval(this.timer);
  }

  // 켜져 있고 마지막 백업이 하루 넘게 지났으면 만든다
  tick() {
    const s = this.settings();
    if (!s.enabled) return;
    const last = this.list()[0];
    if (last && this.now() - last.at < DAY) return;
    try {
      this.runNow();
    } catch (err) {
      console.error("[backup] 실패", err);
    }
  }

  runNow(): BackupItem {
    mkdirSync(this.dir, { recursive: true });
    const name = `proprix-${stamp(this.now())}.sqlite`;
    const path = join(this.dir, name);
    this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    this.copyFiles(name);
    this.prune(this.settings().keep);
    console.log(`[backup] ${name}`);
    return this.item(name);
  }

  private copyFiles(name: string) {
    for (const src of this.files) {
      try {
        if (existsSync(src) && readdirSync(src).length)
          cpSync(src, join(this.dir, filesDir(name), basename(src)), { recursive: true });
      } catch (err) {
        console.error(`[backup] ${basename(src)} 복사 실패`, err);
      }
    }
  }

  private filesSize(name: string): number {
    const root = join(this.dir, filesDir(name));
    if (!existsSync(root)) return 0;
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .reduce((n, e) => n + statSync(join(e.parentPath, e.name)).size, 0);
  }

  list(): BackupItem[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir).filter((n) => NAME.test(n));
    } catch {
      return [];
    }
    return names.map((n) => this.item(n)).sort((a, b) => b.at - a.at);
  }

  private item(name: string): BackupItem {
    const st = statSync(join(this.dir, name));
    return { name, size: st.size + this.filesSize(name), at: st.mtimeMs };
  }

  private prune(keep: number) {
    for (const old of this.list().slice(keep)) {
      rmSync(join(this.dir, old.name), { force: true });
      rmSync(join(this.dir, filesDir(old.name)), { recursive: true, force: true });
    }
  }
}
