// 선제 메시지의 시간 계산 (모두 이 컴퓨터의 로컬 시간 기준)
import type { ProactiveSettings, Reminder } from "@proprix/shared";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

// "2026-10-29 Thu 09:00" — 모델에 보여 주는 형식
export function formatLocal(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEKDAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 로컬 날짜 키 "2026-10-29"
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "YYYY-MM-DD HH:MM" (로컬) → ms. 형식이 틀리거나 없는 날짜면 null
export function parseLocal(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi);
  // 2월 30일처럼 넘친 날짜는 거부
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || h > 23 || mi > 59) return null;
  return date.getTime();
}

// 오늘(now 의 로컬 날짜) "HH:MM" 의 시각
export function todayAt(now: number, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.getTime();
}

// 반복 리마인더의 다음 시각: due 에서 반복 단위로 넘겨 after 보다 뒤인 첫 시각 (놓친 회차는 건너뛴다)
export function nextOccurrence(due: number, repeat: Reminder["repeat"], after: number): number | null {
  if (repeat === "none") return null;
  const d = new Date(due);
  for (let i = 0; i < 4000; i++) {
    d.setDate(d.getDate() + (repeat === "weekly" ? 7 : 1));
    if (repeat === "weekdays" && (d.getDay() === 0 || d.getDay() === 6)) continue;
    if (d.getTime() > after) return d.getTime();
  }
  return null;
}

// 방해 금지 시간대인지 (start 부터 end 전까지, 자정을 넘을 수 있음)
export function inQuiet(now: number, p: ProactiveSettings): boolean {
  if (!p.quietEnabled) return false;
  const h = new Date(now).getHours();
  return p.quietStart < p.quietEnd ? h >= p.quietStart && h < p.quietEnd : h >= p.quietStart || h < p.quietEnd;
}
