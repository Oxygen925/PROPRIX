// 선제 메시지 (가짜 LLM·가짜 시계): 시간 계산, 리마인더 도구, 리마인더·체크인·안부 발송, 방해 금지, 예산 부족 시 고정 문구
import { Database } from "bun:sqlite";
import { expect, setSystemTime, test } from "bun:test";
import {
  type Agent,
  AgentInput,
  type Budgets,
  SETTINGS_DEFAULTS,
  type ServerEvent,
  type Settings,
} from "@proprix/shared";
import type { AiRequest } from "@proprix/siwc";
import { AgentStore, DEFAULT_PERSONA_ID } from "../agents/store";
import type { StreamOptions, StreamResult } from "../auth/account";
import { ChatService } from "../chat/chat";
import { makeChatTools } from "../chat/test-helpers";
import { SummaryService } from "../context/summary";
import { LlmGate } from "../llm/gate";
import { migrate } from "../storage/db";
import { SettingsStore } from "../storage/settings";
import { ProactiveScheduler } from "./scheduler";
import { formatLocal, inQuiet, localDate, nextOccurrence, parseLocal } from "./time";

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test("시간 계산: 로컬 시각 해석, 반복 다음 시각(놓친 회차 건너뜀), 자정 넘는 방해 금지", () => {
  expect(parseLocal("2026-10-29 09:00")).toBe(at(2026, 10, 29, 9));
  expect(parseLocal("2026-02-30 09:00")).toBeNull();
  expect(parseLocal("내일 9시")).toBeNull();
  expect(formatLocal(at(2026, 10, 29, 9, 5))).toBe("2026-10-29 Thu 09:05");
  expect(localDate(at(2026, 10, 29, 23, 59))).toBe("2026-10-29");

  const fri = at(2026, 10, 30, 9);
  expect(nextOccurrence(fri, "none", fri)).toBeNull();
  expect(nextOccurrence(fri, "daily", fri)).toBe(at(2026, 10, 31, 9));
  expect(nextOccurrence(fri, "weekdays", fri)).toBe(at(2026, 11, 2, 9)); // 금 → 월
  expect(nextOccurrence(fri, "weekly", fri)).toBe(at(2026, 11, 6, 9));
  // 사흘 꺼져 있었으면 지난 회차는 건너뛰고 다음 미래 시각으로
  expect(nextOccurrence(fri, "daily", at(2026, 11, 2, 12))).toBe(at(2026, 11, 3, 9));

  const q = { ...SETTINGS_DEFAULTS.proactive }; // 23–8
  expect(inQuiet(at(2026, 10, 29, 23, 30), q)).toBe(true);
  expect(inQuiet(at(2026, 10, 29, 7, 59), q)).toBe(true);
  expect(inQuiet(at(2026, 10, 29, 8, 0), q)).toBe(false);
  expect(inQuiet(at(2026, 10, 29, 3), { ...q, quietEnabled: false })).toBe(false);
  expect(inQuiet(at(2026, 10, 29, 13), { ...q, quietStart: 12, quietEnd: 14 })).toBe(true);
});

type Step = { text?: string; items?: Record<string, unknown>[]; fail?: boolean };

const fc = (name: string, args: object, id = name) => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: `call_${id}`,
  name,
  arguments: JSON.stringify(args),
  status: "completed",
});

function setup(script: (req: AiRequest) => Step = () => ({ text: "응답" }), budgets: Partial<Budgets> = {}) {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  let now = at(2026, 10, 29, 9);
  const requests: AiRequest[] = [];
  const base: StreamResult = {
    outcome: "completed",
    code: "",
    param: "",
    recovery: "none",
    http: 200,
    attempts: 1,
    chars: 0,
    requestId: "",
    items: [],
  };
  const llm = {
    async stream(req: AiRequest, opt: StreamOptions): Promise<StreamResult> {
      requests.push(structuredClone(req));
      const kind = /# Proactive message/.test(req.instructions)
        ? /reminder>/.test(req.instructions)
          ? "reminder"
          : /regular check-in/.test(req.instructions)
            ? "checkin"
            : "nudge"
        : "";
      const s = kind ? { text: `${kind}!` } : script(req);
      if (s.fail) return { ...base, outcome: "failed", code: "x" };
      if (s.text) opt.onDelta(s.text);
      const items = [...(s.items ?? [])];
      if (s.text)
        items.unshift({ type: "message", role: "assistant", content: [{ type: "output_text", text: s.text }] });
      return { ...base, items };
    },
  };
  const events: ServerEvent[] = [];
  const emit = (e: ServerEvent) => events.push(e);
  const settingsStore = new SettingsStore(db);
  settingsStore.set("model", "m");
  const allBudgets: Budgets = { ...SETTINGS_DEFAULTS.budgets, ...budgets };
  const gate = new LlmGate(
    db,
    () => {},
    2,
    () => allBudgets,
    () => now,
  );
  const agents = new AgentStore(db);
  const summaries = new SummaryService(db, llm, gate, emit, () => "a");
  const tools = makeChatTools(db, llm, gate, agents, emit, { now: () => now });
  const chat = new ChatService(db, llm, gate, agents, summaries, tools, emit);
  const agent = agents.createAgent(AgentInput.parse({ personaId: DEFAULT_PERSONA_ID, name: "비서" })) as Agent;
  const room = chat.createRoom("r", [agent.id]);
  if (typeof room === "string") throw new Error(room);
  const sched = new ProactiveScheduler(db, chat, agents, tools.reminders, gate, () => settingsStore.all(), {
    tickMs: 30_000,
    now: () => now,
  });
  const say = async (text: string) => {
    const r = chat.send(room.id, text, "m");
    if (typeof r === "string") throw new Error(r);
    await chat.idle(room.id);
  };
  return {
    db,
    chat,
    agents,
    agent,
    room,
    requests,
    events,
    sched,
    reminders: tools.reminders,
    settings: settingsStore,
    say,
    setNow: (t: number) => {
      now = t;
    },
    msgs: (roomId = room.id) => chat.messages(roomId).filter((m) => m.proactive),
  };
}

test("리마인더 도구: 확인 없이 예약, 지금 시각을 알려 주고, 지난 시각은 거부, 목록·취소", async () => {
  let step = 0;
  const s = setup((req) => {
    const last = req.items?.at(-1);
    if (last?.type === "function_call_output") return { text: "예약했어요" };
    step++;
    if (step === 1)
      return { items: [fc("reminder_create", { text: "약 먹기", when: "2026-10-29 21:00", repeat: "daily" })] };
    if (step === 2)
      return { items: [fc("reminder_create", { text: "지난 일", when: "2026-10-28 09:00", repeat: "none" })] };
    return { items: [fc("reminder_list", {})] };
  });
  await s.say("매일 밤 9시에 약 먹으라고 알려줘");
  const tools = JSON.stringify(s.requests[0]?.tools);
  expect(tools).toContain("Now: 2026-10-29 Thu 09:00");
  const [r] = s.reminders.scheduled(s.room.id);
  expect(r).toMatchObject({ text: "약 먹기", dueAt: at(2026, 10, 29, 21), repeat: "daily", agentId: s.agent.id });
  expect(s.chat.toolCalls(s.room.id).at(-1)).toMatchObject({ name: "reminder_create", status: "done" });

  await s.say("어제 9시에 알려줘");
  expect(s.chat.toolCalls(s.room.id).at(-1)?.output).toContain("that time has passed");
  await s.say("목록");
  expect(s.chat.toolCalls(s.room.id).at(-1)?.output).toContain("약 먹기");
  expect(s.events.some((e) => e.type === "reminders")).toBe(false); // test-helpers 는 이벤트를 연결하지 않음
  expect(s.reminders.cancel(r?.id ?? "")).toBe(true);
  expect(s.reminders.scheduled()).toEqual([]);
});

test("리마인더 발송: 시각이 되면 그 방에 생성, 반복은 다음 날로, 늦으면 원래 시각을 알리고, 방해 금지 동안은 미룬다", async () => {
  const s = setup();
  s.reminders.create({
    roomId: s.room.id,
    agentId: s.agent.id,
    text: "물 마시기",
    dueAt: at(2026, 10, 29, 10),
    repeat: "daily",
  });
  s.reminders.create({
    roomId: s.room.id,
    agentId: s.agent.id,
    text: "한 번만",
    dueAt: at(2026, 10, 29, 23, 30),
    repeat: "none",
  });

  await s.sched.tick();
  expect(s.msgs()).toEqual([]); // 아직

  s.setNow(at(2026, 10, 29, 10, 0));
  await s.sched.tick();
  expect(s.msgs().map((m) => [m.proactive, m.content])).toEqual([["reminder", "reminder!"]]);
  const req = s.requests.at(-1);
  expect(req?.instructions).toContain("<reminder>\n물 마시기\n</reminder>");
  expect(req?.instructions).not.toContain("It was due at");
  expect(req?.tools ?? []).toEqual([]);
  expect(req?.turns.at(-1)?.text).toContain("has not written anything new");
  expect(s.reminders.scheduled().map((r) => [r.text, r.dueAt])).toEqual([
    ["한 번만", at(2026, 10, 29, 23, 30)],
    ["물 마시기", at(2026, 10, 30, 10)],
  ]);

  // 23:30 은 방해 금지(23–8) → 아침 8시 이후에, 늦었다고 알리며
  s.setNow(at(2026, 10, 29, 23, 40));
  await s.sched.tick();
  expect(s.msgs()).toHaveLength(1);
  s.setNow(at(2026, 10, 30, 8, 1));
  await s.sched.tick();
  expect(s.msgs().map((m) => m.content)).toEqual(["reminder!", "reminder!"]);
  expect(s.requests.at(-1)?.instructions).toContain("It was due at 2026-10-29 Thu 23:30");
  expect(s.reminders.scheduled().map((r) => r.text)).toEqual(["물 마시기"]); // 한 번짜리는 끝
});

test("리마인더: 방이 응답 중이면 다음에, 예산이 없으면 고정 문구로 (LLM 호출 없음)", async () => {
  const s = setup(() => ({ text: "느린 응답" }), { proactive: 1 });
  s.reminders.create({
    roomId: s.room.id,
    agentId: s.agent.id,
    text: "첫째",
    dueAt: at(2026, 10, 29, 9),
    repeat: "none",
  });
  const r = s.chat.send(s.room.id, "대화 중", "m");
  if (typeof r === "string") throw new Error(r);
  await s.sched.tick(); // 방이 바쁨 → 미룸
  await s.chat.idle(s.room.id);
  expect(s.reminders.scheduled()).toHaveLength(1);
  await s.sched.tick();
  expect(s.msgs().map((m) => m.content)).toEqual(["reminder!"]);

  // 오늘 proactive 예산 1 을 다 씀 → 고정 문구
  s.reminders.create({
    roomId: s.room.id,
    agentId: s.agent.id,
    text: "둘째",
    dueAt: at(2026, 10, 29, 9),
    repeat: "none",
  });
  const before = s.requests.length;
  await s.sched.tick();
  expect(s.msgs().map((m) => m.content)).toEqual(["reminder!", "⏰ 둘째"]);
  expect(s.requests.length).toBe(before);
});

test("체크인: 정한 시각 뒤 하루 한 번, 그 에이전트 혼자 있는 방으로, 방해 금지·2시간 넘게 늦으면 그날 건너뜀", async () => {
  const s = setup();
  // 이 에이전트는 그룹방에만 있다 → 혼자 있는 방을 새로 만든다
  const other = s.agents.createAgent(AgentInput.parse({ personaId: DEFAULT_PERSONA_ID, name: "친구" })) as Agent;
  s.chat.updateRoom(s.room.id, { agentIds: [s.agent.id, other.id] });
  s.agents.updateAgent(s.agent.id, {
    ...s.agent,
    checkin: { enabled: true, time: "09:30", days: [0, 1, 2, 3, 4, 5, 6] },
  });

  s.setNow(at(2026, 10, 29, 9, 0));
  await s.sched.tick();
  expect(s.chat.listRooms()).toHaveLength(1);
  s.setNow(at(2026, 10, 29, 9, 31));
  await s.sched.tick();
  const solo = s.chat.soloRoom(s.agent.id);
  expect(solo?.agentIds).toEqual([s.agent.id]);
  expect(s.msgs(solo?.id).map((m) => [m.proactive, m.agentId])).toEqual([["checkin", s.agent.id]]);
  expect(s.events.some((e) => e.type === "rooms")).toBe(true);

  s.setNow(at(2026, 10, 29, 10, 0));
  await s.sched.tick();
  expect(s.msgs(solo?.id)).toHaveLength(1); // 하루 한 번

  // 다음 날은 11:45 에야 켜짐 → 2시간 넘게 지나 건너뜀
  s.setNow(at(2026, 10, 30, 11, 45));
  await s.sched.tick();
  expect(s.msgs(solo?.id)).toHaveLength(1);
  expect(s.agents.checkinLast(s.agent.id)).toBe("2026-10-30");

  // 방해 금지 안의 시각(07:00) → 매일 건너뜀
  s.agents.updateAgent(s.agent.id, {
    ...s.agent,
    checkin: { enabled: true, time: "07:00", days: [0, 1, 2, 3, 4, 5, 6] },
  });
  s.setNow(at(2026, 10, 31, 7, 5));
  await s.sched.tick();
  expect(s.msgs(solo?.id)).toHaveLength(1);
  // 편집기 저장이 처리한 날짜를 지우지 않는다
  expect(s.agents.checkinLast(s.agent.id)).toBe("2026-10-31");
});

test("안부: 켜져 있으면 마지막 대화 뒤 N일이 지나 그 방에 한 번, 사용자가 다시 말하면 새로 센다", async () => {
  const s = setup();
  // 메시지 시각은 실제 시계로 찍히므로 시계를 고정한다 (아니면 실제 날짜가 다가오면 실패)
  setSystemTime(new Date(at(2026, 10, 29, 12)));
  try {
    await s.say("안녕");
  } finally {
    setSystemTime();
  }
  s.setNow(at(2026, 11, 1, 12)); // 3일 뒤
  await s.sched.tick();
  expect(s.msgs()).toEqual([]); // 꺼짐
  s.settings.patch({ proactive: { nudgeEnabled: true, nudgeDays: 3 } });
  s.setNow(at(2026, 11, 2, 12));
  await s.sched.tick();
  expect(s.msgs().map((m) => [m.proactive, m.agentId])).toEqual([["nudge", s.agent.id]]);
  expect(s.requests.at(-1)?.instructions).toContain("has not talked with you for");
  s.setNow(at(2026, 11, 3, 12));
  await s.sched.tick();
  expect(s.msgs()).toHaveLength(1); // 같은 침묵에는 한 번

  // 안부 메시지는 사용자 메시지가 아니므로 기준이 바뀌지 않는다. 사용자가 다시 말하면 새로 센다
  const last = s.chat.lastUserActivity();
  expect(last?.at).toBeLessThan(at(2026, 11, 1, 0));
});

test("설정: 방해 금지 시작과 끝이 같으면 거부", () => {
  const s = setup();
  expect(s.settings.patch({ proactive: { quietStart: 5, quietEnd: 5 } })).toBe("방해 금지 시작과 끝이 같을 수 없다");
  const ok = s.settings.patch({ proactive: { quietStart: 22 } }) as Settings;
  expect(ok.proactive).toMatchObject({ quietStart: 22, quietEnd: 8 });
});
