// 반복 예약 작업 (P8): 일정 형식·다음 실행 계산·설명. daemon(스케줄러·저장 검사)과 화면(미리보기)이 같이 쓴다.
// 시각은 모두 이 컴퓨터의 로컬 시간
import { z } from "zod";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "시각은 HH:MM");
export const MIN_TASK_GAP_MS = 60 * 60_000; // 실행 사이 최소 간격 (플랜 사용량 보호)

export const TaskSchedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), time: HHMM }),
  z.object({ kind: z.literal("weekly"), time: HHMM, days: z.array(z.number().int().min(0).max(6)).min(1).max(7) }),
  // 그 달에 없는 날(31일 등)은 그 달의 마지막 날
  z.object({ kind: z.literal("monthly"), time: HHMM, day: z.number().int().min(1).max(31) }),
  // anchor: 기준 시각 (저장할 때 daemon 이 정한다)
  z.object({
    kind: z.literal("interval"),
    hours: z
      .number()
      .int()
      .min(1)
      .max(24 * 31),
    anchor: z.number().optional(),
  }),
  z.object({ kind: z.literal("cron"), cron: z.string().trim().min(9).max(120) }),
]);
export type TaskSchedule = z.infer<typeof TaskSchedule>;

export const TaskInput = z.object({
  title: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(8000),
  agentId: z.string().min(1),
  roomId: z.string().min(1),
  schedule: TaskSchedule,
  allowedTools: z.array(z.string().max(64)).max(30).default([]), // 확인 없이 할 쓰기 도구
  enabled: z.boolean().default(true),
});
export type TaskInput = z.input<typeof TaskInput>;

export const TaskRunStatus = z.enum(["running", "done", "failed", "skipped", "cancelled"]);
export const Task = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  agentId: z.string(),
  roomId: z.string(),
  schedule: TaskSchedule,
  scheduleText: z.string(),
  allowedTools: z.array(z.string()),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  lastStatus: z.string(), // 마지막 실행 상태 ("" = 아직 없음)
  createdBy: z.string(), // 'user' 또는 만든 에이전트 id
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof Task>;

export const TaskRun = z.object({
  id: z.string(),
  taskId: z.string(),
  scheduledFor: z.number().nullable(), // null = '지금 실행'
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  status: TaskRunStatus,
  reason: z.string(), // missed · budget · busy · paused · timeout · 오류 코드
  messageId: z.string(),
  requests: z.number(),
  rejected: z.number(), // 예약 작업이라 거절한 도구 호출 수
});
export type TaskRun = z.infer<typeof TaskRun>;

export const TaskPreviewRequest = z.object({
  schedule: TaskSchedule,
  count: z.number().int().min(1).max(10).default(5),
});
export const TaskPreview = z.object({ text: z.string(), next: z.array(z.number()), error: z.string() });
export type TaskPreview = z.infer<typeof TaskPreview>;

// ---- cron (표준 5필드: 분 시 일 월 요일) ----

interface Cron {
  minutes: number[];
  hours: number[];
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function cronField(raw: string, min: number, max: number, names: string[] = [], base = 0): Set<number> {
  const out = new Set<number>();
  const num = (s: string): number => {
    const i = names.indexOf(s.toUpperCase());
    const n = i >= 0 ? i + base : /^\d+$/.test(s) ? Number(s) : Number.NaN;
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`범위 밖 값: ${s}`);
    return n;
  };
  for (const part of raw.split(",")) {
    const [range = "", stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`잘못된 간격: ${part}`);
    let lo: number;
    let hi: number;
    if (range === "*" || range === "?") [lo, hi] = [min, max];
    else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      [lo, hi] = [num(a), num(b)];
      if (lo > hi) throw new Error(`잘못된 범위: ${range}`);
    } else {
      lo = num(range);
      hi = stepRaw === undefined ? lo : max; // "5/15" = 5부터 끝까지 15씩
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error("cron 은 '분 시 일 월 요일' 5칸입니다");
  const [mi = "", h = "", dom = "", mon = "", dow = ""] = f;
  const dows = cronField(dow, 0, 7, DAYS);
  if (dows.has(7)) dows.add(0); // 7 = 일요일
  return {
    minutes: [...cronField(mi, 0, 59)].sort((a, b) => a - b),
    hours: [...cronField(h, 0, 23)].sort((a, b) => a - b),
    doms: cronField(dom, 1, 31),
    months: cronField(mon, 1, 12, MONTHS, 1),
    dows,
    domAny: dom === "*" || dom === "?",
    dowAny: dow === "*" || dow === "?",
  };
}

// 일·요일을 둘 다 정하면 둘 중 하나만 맞아도 된다 (표준 cron)
function cronDay(c: Cron, d: Date): boolean {
  if (!c.months.has(d.getMonth() + 1)) return false;
  const dom = c.doms.has(d.getDate());
  const dow = c.dows.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

function cronNext(c: Cron, after: number): number | null {
  const a = new Date(after);
  let day = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  for (let i = 0; i < 366 * 5; i++) {
    if (cronDay(c, day))
      for (const h of c.hours)
        for (const m of c.minutes) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
          if (t > after) return t;
        }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }
  return null;
}

// ---- 다음 실행 ----

const at = (base: Date, hhmm: string, dayOffset = 0): number => {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, h, m).getTime();
};

/** after 보다 뒤의 첫 실행 시각 (없으면 null) */
export function nextRun(s: TaskSchedule, after: number): number | null {
  const now = new Date(after);
  switch (s.kind) {
    case "daily":
    case "weekly":
      for (let i = 0; i <= 7; i++) {
        const t = at(now, s.time, i);
        if (t > after && (s.kind === "daily" || s.days.includes(new Date(t).getDay()))) return t;
      }
      return null;
    case "monthly":
      for (let i = 0; i <= 24; i++) {
        const last = new Date(now.getFullYear(), now.getMonth() + i + 1, 0).getDate();
        const t = at(new Date(now.getFullYear(), now.getMonth() + i, Math.min(s.day, last)), s.time);
        if (t > after) return t;
      }
      return null;
    case "interval": {
      const step = s.hours * 3_600_000;
      const anchor = s.anchor ?? after;
      if (after < anchor) return anchor;
      return anchor + (Math.floor((after - anchor) / step) + 1) * step;
    }
    case "cron":
      return cronNext(parseCron(s.cron), after);
  }
}

export function upcoming(s: TaskSchedule, after: number, n: number): number[] {
  const out: number[] = [];
  let t: number | null = after;
  while (out.length < n && t !== null) {
    t = nextRun(s, t);
    if (t !== null) out.push(t);
  }
  return out;
}

/** 저장할 수 없는 일정이면 사유 ("" = 괜찮음). cron 은 앞으로 몇 회의 간격까지 본다 */
export function scheduleError(s: TaskSchedule, now: number): string {
  try {
    const next = upcoming(s, now, 24);
    if (next.length === 0) return "앞으로 실행할 시각이 없습니다";
    for (let i = 1; i < next.length; i++)
      if ((next[i] ?? 0) - (next[i - 1] ?? 0) < MIN_TASK_GAP_MS) return "실행 사이 간격은 1시간 이상이어야 합니다";
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

/** 화면·확인 카드용 설명 */
export function describeSchedule(s: TaskSchedule): string {
  switch (s.kind) {
    case "daily":
      return `매일 ${s.time}`;
    case "weekly": {
      const d = [...new Set(s.days)].sort((a, b) => a - b);
      const key = d.join(",");
      if (key === "1,2,3,4,5") return `평일 ${s.time}`;
      if (key === "0,6") return `주말 ${s.time}`;
      if (d.length === 7) return `매일 ${s.time}`;
      return `매주 ${d.map((x) => DAY_NAMES[x]).join("·")} ${s.time}`;
    }
    case "monthly":
      return `매월 ${s.day}일${s.day > 28 ? "(없으면 말일)" : ""} ${s.time}`;
    case "interval":
      return `${s.hours}시간마다`;
    case "cron":
      return `cron ${s.cron}`;
  }
}
