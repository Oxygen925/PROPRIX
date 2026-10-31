import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupService } from "./backup";

test("표정·테마 파일: 사본과 함께 복사하고 함께 지운다. 빈 폴더는 만들지 않는다", () => {
  const root = mkdtempSync(join(tmpdir(), "proprix-backup-"));
  try {
    const characters = join(root, "characters");
    mkdirSync(join(characters, "p1"), { recursive: true });
    writeFileSync(join(characters, "p1", "smile.png"), "그림");
    const themes = join(root, "themes");
    mkdirSync(themes);
    const dir = join(root, "backups");
    let now = new Date(2026, 9, 1, 12).getTime();
    const b = new BackupService(
      new Database(":memory:"),
      dir,
      () => ({ enabled: true, keep: 1 }),
      () => now,
      [characters, themes, join(root, "없는 폴더")],
    );
    const first = b.runNow();
    const files = join(dir, first.name.replace(".sqlite", "-files"));
    expect(readFileSync(join(files, "characters", "p1", "smile.png"), "utf8")).toBe("그림");
    expect(existsSync(join(files, "themes"))).toBe(false);
    expect(first.size).toBeGreaterThan(Buffer.byteLength("그림"));
    expect(b.list().map((x) => x.name)).toEqual([first.name]); // 폴더는 목록에 따로 나오지 않는다

    now += 24 * 60 * 60 * 1000;
    const second = b.runNow();
    expect(b.list().map((x) => x.name)).toEqual([second.name]);
    expect(existsSync(files)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
