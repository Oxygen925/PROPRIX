import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { CommandInput } from "@proprix/shared";
import { migrate } from "../storage/db";
import { CommandStore } from "./store";

function setup() {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  let changed = 0;
  const store = new CommandStore(db, () => changed++);
  return { store, changed: () => changed };
}
const input = (name: string, template = "x") => CommandInput.parse({ name, template });

test("만들기·고치기·지우기와 이름 충돌 (대소문자·NFC 무시, 자기 자신은 제외)", () => {
  const s = setup();
  const a = s.store.create(input("Review", "리뷰: $ARGUMENTS"));
  if ("error" in a) throw new Error(a.message);
  expect(s.store.create(input("review"))).toMatchObject({ error: "taken" });
  const han = s.store.create(input("한글"));
  if ("error" in han) throw new Error(han.message);
  expect(s.store.create(input("한글".normalize("NFD")))).toMatchObject({ error: "taken" });
  // 자기 이름 그대로 고치기는 된다, 다른 명령 이름으로는 안 된다
  expect(s.store.update(a.id, input("REVIEW", "새 템플릿"))).toMatchObject({ name: "REVIEW", template: "새 템플릿" });
  expect(s.store.update(a.id, input("한글"))).toMatchObject({ error: "taken" });
  expect(s.store.update(crypto.randomUUID(), input("zzz"))).toMatchObject({ error: "not_found" });
  expect(s.store.list().map((c) => c.name)).toEqual(["REVIEW", "한글"]);
  expect(s.store.delete(a.id)).toBe(true);
  expect(s.store.delete(a.id)).toBe(false);
  expect(s.changed()).toBe(4);
});

test("내장 명령 이름은 저장할 수 없고, 같은 이름 공간의 다른 주인(skill)과도 겹칠 수 없다", () => {
  const s = setup();
  expect(s.store.create({ name: "Pin", description: "", template: "x" })).toMatchObject({ error: "invalid" });
  s.store.otherOwners.push((key) => key === "deploy");
  expect(s.store.create(input("Deploy"))).toMatchObject({ error: "taken" });
  expect(s.store.nameTaken("deploy")).toBe(true);
  expect(s.store.nameTaken("other")).toBe(false);
});
