// 팀 프리셋 (P10d): 만들기·고치기·지우기, 이름(대소문자 무시) 중복, 없는 에이전트, 에이전트를 지우면 팀에서 빠짐
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Team, TeamInput } from "@proprix/shared";
import { migrate } from "../storage/db";
import { TeamStore } from "./store";

function setup() {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  const agents = new Set(["a", "b", "c"]);
  let changes = 0;
  const store = new TeamStore(
    db,
    (id) => agents.has(id),
    () => changes++,
  );
  return { store, changes: () => changes };
}

const input = (patch: Partial<TeamInput> = {}) =>
  TeamInput.parse({ name: "리서치팀", description: "검색·정리·검토", agentIds: ["a", "b", "c"], ...patch });

test("만들기·찾기·고치기·지우기", () => {
  const s = setup();
  const t = s.store.create(input({ chainLimit: 4 })) as Team;
  expect(t).toMatchObject({ name: "리서치팀", agentIds: ["a", "b", "c"], chainLimit: 4 });
  expect(s.store.byName("  리서치팀 ")?.id).toBe(t.id);
  const u = s.store.update(t.id, input({ name: "Review", agentIds: ["c", "a"] })) as Team;
  expect(u).toMatchObject({ name: "Review", agentIds: ["c", "a"], chainLimit: 3 });
  expect(s.store.byName("review")?.id).toBe(t.id);
  expect(s.store.list()).toHaveLength(1);
  expect(s.store.delete(t.id)).toBe(true);
  expect(s.store.delete(t.id)).toBe(false);
  expect(s.changes()).toBe(3);
});

test("검증: 이름은 대소문자 무시로 겹칠 수 없고, 없는 에이전트·1명·같은 에이전트 두 번은 안 된다", () => {
  const s = setup();
  const t = s.store.create(input({ name: "Team" })) as Team;
  expect(s.store.create(input({ name: " team " }))).toMatchObject({ error: "taken" });
  const other = s.store.create(input({ name: "Other" })) as Team;
  expect(s.store.update(other.id, input({ name: "TEAM" }))).toMatchObject({ error: "taken" });
  expect(s.store.update(t.id, input({ name: "team" }))).toMatchObject({ name: "team" }); // 자기 이름은 대소문자만 바꿔도 된다
  expect(s.store.create(input({ name: "x", agentIds: ["a", "zz"] }))).toMatchObject({ error: "invalid" });
  expect(s.store.update("missing", input())).toMatchObject({ error: "not_found" });
  expect(TeamInput.safeParse({ name: "y", agentIds: ["a"] }).success).toBe(false);
  expect(TeamInput.safeParse({ name: "y", agentIds: ["a", "a"] }).success).toBe(false);
});

test("에이전트를 지우면 모든 팀에서 빠지고, 2명 미만이 된 팀도 남는다", () => {
  const s = setup();
  const big = s.store.create(input({ name: "셋" })) as Team;
  const pair = s.store.create(input({ name: "둘", agentIds: ["a", "b"] })) as Team;
  const before = s.changes();
  s.store.removeAgent("b");
  expect(s.store.get(big.id)?.agentIds).toEqual(["a", "c"]);
  expect(s.store.get(pair.id)?.agentIds).toEqual(["a"]);
  expect(s.changes()).toBe(before + 1);
  s.store.removeAgent("nobody");
  expect(s.changes()).toBe(before + 1);
});
