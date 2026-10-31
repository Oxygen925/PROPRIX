import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { DEFAULT_BUDGETS } from "@proprix/shared";
import type { StreamResult } from "../auth/account";
import { migrate } from "../storage/db";
import { BUDGET_EXCEEDED, LlmGate } from "./gate";

const result = (over: Partial<StreamResult> = {}): StreamResult => ({
  outcome: "completed",
  code: "",
  param: "",
  recovery: "none",
  http: 200,
  attempts: 1,
  chars: 1,
  requestId: "",
  items: [],
  ...over,
});

function makeGate(concurrency: number) {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  return { db, gate: new LlmGate(db, () => {}, concurrency) };
}

// 슬롯 인계(release 가 active 를 줄이지 않고 대기자에게 넘김)의 마이크로태스크 경합 자체는 타이머로 재현할 수 없어,
// 여기서는 겹치는 요청들 사이에서 상한이 지켜지고 대기열이 비는지를 본다
test("예산 알림: 80%(올림)·100% 에 닿는 순간 한 번씩, 무제한·preview 는 없음, tasks 도 오늘 사용량에", async () => {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  const budgets = { ...DEFAULT_BUDGETS, router: 5, delegate: 1 };
  const gate = new LlmGate(
    db,
    () => {},
    2,
    () => budgets,
  );
  const alerts: string[] = [];
  gate.onUsageAlert = (a) => alerts.push(`${a.feature}:${a.level}:${a.used}/${a.limit}`);
  for (let i = 0; i < 6; i++) await gate.run("router", "m", async () => result());
  await gate.run("delegate", "m", async () => result()); // 상한 1: 80% 와 100% 가 같은 자리 → 100 만
  await gate.run("chat", "m", async () => result());
  await gate.run("preview", "m", async () => result());
  expect(alerts).toEqual(["router:80:4/5", "router:100:5/5", "delegate:100:1/1"]);
  expect(gate.usageToday().features.map((f) => f.feature)).toContain("tasks");
});

test("기록: 최근 n 일의 로컬 날짜·기능별 요청 수, 그 전은 빠진다", async () => {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  let now = new Date(2026, 9, 29, 15, 0).getTime();
  const gate = new LlmGate(
    db,
    () => {},
    2,
    () => null,
    () => now,
  );
  await gate.run("chat", "m", async () => result());
  await gate.run("chat", "m", async () => result());
  await gate.run("tasks", "m", async () => result());
  now = new Date(2026, 9, 28, 0, 5).getTime(); // 어제 자정 직후 (로컬)
  await gate.run("chat", "m", async () => result());
  now = new Date(2026, 9, 20, 12, 0).getTime(); // 범위 밖
  await gate.run("chat", "m", async () => result());
  now = new Date(2026, 9, 29, 15, 0).getTime();
  const h = gate.history(7);
  expect(h.since).toBe(new Date(2026, 9, 23).getTime());
  expect(h.days).toEqual([
    { date: "2026-10-28", feature: "chat", count: 1 },
    { date: "2026-10-29", feature: "chat", count: 2 },
    { date: "2026-10-29", feature: "tasks", count: 1 },
  ]);
});

test("동시성 상한과 대기열", async () => {
  const { gate } = makeGate(1);
  let active = 0;
  let peak = 0;
  const job = () =>
    gate.run("chat", "m", async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;
      return result();
    });
  const first = [job(), job(), job()];
  await Bun.sleep(7); // 첫 요청이 끝나 슬롯을 넘기는 순간에 새 요청을 넣는다
  const late = [job(), job()];
  await Promise.all([...first, ...late]);
  expect(peak).toBe(1);
  expect(gate.status()).toMatchObject({ active: 0, queued: 0 });
});

test("사용량 한도: 일시정지, 대기 중이던 요청도 보내지 않음, 재개", async () => {
  const { db, gate } = makeGate(1);
  let calls = 0;
  const limited = gate.run("chat", "m", async () => {
    calls++;
    await Bun.sleep(5);
    return result({ outcome: "failed", code: "subscription_sharing_usage_limit_exceeded", recovery: "usage_limit" });
  });
  const queued = gate.run("chat", "m", async () => {
    calls++;
    return result();
  });
  expect((await limited).recovery).toBe("usage_limit");
  expect(await queued).toMatchObject({ recovery: "usage_limit", attempts: 0 });
  expect(calls).toBe(1);
  expect(gate.status()).toMatchObject({ paused: true, pausedCode: "subscription_sharing_usage_limit_exceeded" });

  gate.resume();
  expect((await gate.run("chat", "m", async () => result())).outcome).toBe("completed");
  expect(db.query("SELECT COUNT(*) AS n FROM usage_ledger").get()).toEqual({ n: 2 });
});

test("일일 예산: 상한에 닿으면 요청하지 않고, 진행 중인 요청도 세며, 자정에 초기화된다", async () => {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  let now = new Date(2026, 9, 28, 23, 0).getTime();
  const budgets = { ...DEFAULT_BUDGETS, memory: 2, chat: null };
  const gate = new LlmGate(
    db,
    () => {},
    4,
    () => budgets,
    () => now,
  );
  let calls = 0;
  const slow = () =>
    gate.run("memory", "m", async () => {
      calls++;
      await Bun.sleep(5);
      return result();
    });
  // 동시에 3개: 진행 중인 것까지 세므로 세 번째는 바로 거절
  const rs = await Promise.all([slow(), slow(), slow()]);
  expect(rs.map((r) => r.code)).toEqual(["", "", BUDGET_EXCEEDED]);
  expect(calls).toBe(2);
  expect(gate.remaining("memory")).toBe(0);
  expect(gate.usageToday().features.find((f) => f.feature === "memory")).toEqual({
    feature: "memory",
    used: 2,
    limit: 2,
  });
  // 거절은 장부에 남기지 않는다
  expect(db.query("SELECT COUNT(*) AS n FROM usage_ledger").get()).toEqual({ n: 2 });

  // 무제한 기능·예산 밖 기능은 막지 않는다
  expect((await gate.run("chat", "m", async () => result())).code).toBe("");
  expect((await gate.run("preview", "m", async () => result())).code).toBe("");
  expect(gate.remaining("chat")).toBeNull();

  now = new Date(2026, 9, 29, 0, 1).getTime(); // 다음 날
  expect(gate.remaining("memory")).toBe(2);
  expect((await slow()).code).toBe("");
});
