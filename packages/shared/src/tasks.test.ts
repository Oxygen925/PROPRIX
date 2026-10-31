import { expect, test } from "bun:test";
import { describeSchedule, nextRun, parseCron, scheduleError, upcoming } from "./tasks";

// 로컬 시각으로 만든다 (계산이 로컬 기준)
const L = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const fmt = (t: number | null) => {
  if (t === null) return null;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

test("매일·요일: 오늘 시각이 지났으면 다음 날, 고른 요일만", () => {
  const thu = L(2026, 10, 29, 10, 0); // 목요일
  expect(fmt(nextRun({ kind: "daily", time: "09:00" }, thu))).toBe("2026-10-30 09:00");
  expect(fmt(nextRun({ kind: "daily", time: "11:30" }, thu))).toBe("2026-10-29 11:30");
  expect(fmt(nextRun({ kind: "weekly", time: "09:00", days: [1, 3] }, thu))).toBe("2026-11-02 09:00");
  expect(fmt(nextRun({ kind: "weekly", time: "10:00", days: [4] }, thu))).toBe("2026-11-05 10:00"); // 정각과 같으면 다음 주
});

test("매월: 없는 날은 말일, 윤년 2월", () => {
  const s = { kind: "monthly" as const, time: "08:30", day: 31 };
  expect(upcoming(s, L(2026, 10, 31, 9, 0), 4).map(fmt)).toEqual([
    "2026-11-30 08:30",
    "2026-12-31 08:30",
    "2027-01-31 08:30",
    "2027-02-28 08:30",
  ]);
  expect(fmt(nextRun({ kind: "monthly", time: "00:00", day: 29 }, L(2028, 2, 1)))).toBe("2028-02-29 00:00");
});

test("N시간마다: 기준 시각부터", () => {
  const anchor = L(2026, 10, 29, 9, 15);
  const s = { kind: "interval" as const, hours: 6, anchor };
  expect(fmt(nextRun(s, L(2026, 10, 29, 8, 0)))).toBe("2026-10-29 09:15");
  expect(fmt(nextRun(s, anchor))).toBe("2026-10-29 15:15");
  expect(fmt(nextRun(s, L(2026, 10, 30, 4, 0)))).toBe("2026-10-30 09:15");
});

test("cron: 목록·범위·간격·이름·7=일요일, 일·요일 OR", () => {
  const from = L(2026, 10, 29, 10, 0); // 목
  const n = (expr: string, k = 3) => upcoming({ kind: "cron", cron: expr }, from, k).map(fmt);
  expect(n("0 9 * * MON-FRI")).toEqual(["2026-10-30 09:00", "2026-11-02 09:00", "2026-11-03 09:00"]);
  expect(n("30 8,18 * * *", 2)).toEqual(["2026-10-29 18:30", "2026-10-30 08:30"]);
  expect(n("0 */6 * * *", 3)).toEqual(["2026-10-29 12:00", "2026-10-29 18:00", "2026-10-30 00:00"]);
  expect(n("0 9 * * 7", 1)).toEqual(["2026-11-01 09:00"]);
  expect(n("0 9 1 JAN *", 1)).toEqual(["2027-01-01 09:00"]);
  // 1일 또는 금요일
  expect(n("0 9 1 * FRI", 3)).toEqual(["2026-10-30 09:00", "2026-11-01 09:00", "2026-11-06 09:00"]);
  expect(n("5/20 9 * * *", 3)).toEqual(["2026-10-30 09:05", "2026-10-30 09:25", "2026-10-30 09:45"]);
  for (const bad of ["* * * *", "60 * * * *", "0 25 * * *", "0 9 * * MOX", "0 9-3 * * *", "*/0 * * * *"])
    expect(() => parseCron(bad)).toThrow();
});

test("저장 검사: 1시간 미만 간격·잘못된 cron·실행할 날 없음 거부", () => {
  const now = L(2026, 10, 29, 10);
  expect(scheduleError({ kind: "cron", cron: "*/30 * * * *" }, now)).toContain("1시간");
  expect(scheduleError({ kind: "cron", cron: "0,30 9 * * *" }, now)).toContain("1시간");
  expect(scheduleError({ kind: "cron", cron: "0 * * * *" }, now)).toBe("");
  expect(scheduleError({ kind: "cron", cron: "0 9 31 2 *" }, now)).toContain("없습니다");
  expect(scheduleError({ kind: "cron", cron: "nope nope" }, now)).not.toBe("");
  expect(scheduleError({ kind: "daily", time: "09:00" }, now)).toBe("");
});

test("설명", () => {
  expect(describeSchedule({ kind: "weekly", time: "09:00", days: [5, 1, 2, 3, 4] })).toBe("평일 09:00");
  expect(describeSchedule({ kind: "weekly", time: "09:00", days: [1, 3] })).toBe("매주 월·수 09:00");
  expect(describeSchedule({ kind: "monthly", time: "08:30", day: 31 })).toBe("매월 31일(없으면 말일) 08:30");
  expect(describeSchedule({ kind: "interval", hours: 6 })).toBe("6시간마다");
});
