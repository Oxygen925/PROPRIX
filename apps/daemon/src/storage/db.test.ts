import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS, migrate } from "./db";

test("마이그레이션은 한 번만 적용된다", () => {
  const db = new Database(":memory:", { strict: true });
  expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.id));
  expect(migrate(db)).toEqual([]);
  db.query("INSERT INTO settings (key, value, updated_at) VALUES ('a', '1', 0)").run();
  expect(db.query<{ value: string }, []>("SELECT value FROM settings").get()?.value).toBe("1");
});

test("실패한 마이그레이션은 롤백되고 기록되지 않는다", () => {
  const db = new Database(":memory:", { strict: true });
  const broken = [{ id: 1, name: "broken", sql: "CREATE TABLE t (x INTEGER); SELECT * FROM missing_table;" }];
  expect(() => migrate(db, broken)).toThrow();
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 't'").get()).toBeNull();
  expect(db.query("SELECT * FROM schema_migrations").all()).toEqual([]);
});
