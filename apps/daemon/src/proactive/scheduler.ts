// 선제 메시지 스케줄러: 리마인더·정기 체크인·무응답 안부를 시각이 되면 보낸다 (문구는 보낼 때 생성).
// 방해 금지 시간대: 리마인더는 끝난 뒤 보내고, 체크인은 그날 건너뛰고, 안부는 끝난 뒤로 미룬다 (사용자 결정 2026-10-28).
// 놓친 일을 몰아서 하지 않는다: 반복 리마인더는 한 번만, 2시간 넘게 지난 체크인은 건너뛴다.
import type { Database } from "bun:sqlite";
import type { Settings } from "@proprix/shared";
import type { AgentStore } from "../agents/store";
import type { ChatService } from "../chat/chat";
import type { LlmGate } from "../llm/gate";
import { pickModel } from "../llm/model";
import type { ReminderStore } from "./reminders";
import { formatLocal, inQuiet, localDate, nextOccurrence, todayAt } from "./time";

export interface ProactiveOptions {
  tickMs: number;
  now: () => number;
}

export const DEFAULT_PROACTIVE_OPTIONS: ProactiveOptions = { tickMs: 30_000, now: Date.now };

const LATE_MS = 10 * 60_000; // 이만큼 늦으면 원래 시각을 알려 준다
const CHECKIN_WINDOW_MS = 2 * 60 * 60_000; // 예정 시각에서 이만큼 지나면 그날 체크인은 건너뜀
const DAY_MS = 86_400_000;
const NUDGE_KEY = "nudged_for"; // 안부를 보낸 기준 (마지막 사용자 메시지 시각)

export class ProactiveScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly db: Database,
    private readonly chat: ChatService,
    private readonly agents: AgentStore,
    private readonly reminders: ReminderStore,
    private readonly gate: LlmGate,
    private readonly settings: () => Settings,
    private readonly opt: ProactiveOptions = DEFAULT_PROACTIVE_OPTIONS,
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), this.opt.tickMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  private model(): string {
    return pickModel(this.settings(), () => this.chat.lastModel());
  }

  // 남은 예산이 없으면 LLM 을 부르지 않는다 (체크인·안부는 미루고, 리마인더는 고정 문구로)
  private canGenerate(): boolean {
    return !this.gate.status().paused && this.gate.remaining("proactive") !== 0 && this.model() !== "";
  }

  // 한 번 훑는다. 테스트는 보낸 메시지가 끝날 때까지 기다릴 수 있게 Promise 를 모아 돌려준다
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const pending: Promise<unknown>[] = [];
    try {
      const st = this.settings();
      const now = this.opt.now();
      if (!inQuiet(now, st.proactive)) {
        pending.push(...this.fireReminders(now));
        pending.push(...this.fireNudge(now, st));
      }
      pending.push(...this.fireCheckins(now, st));
    } catch (err) {
      console.error("[proactive] 처리 예외", err);
    } finally {
      this.ticking = false;
    }
    await Promise.all(pending);
  }

  private fireReminders(now: number): Promise<unknown>[] {
    const out: Promise<unknown>[] = [];
    const busyRooms = new Set<string>();
    for (const r of this.reminders.due(now)) {
      if (busyRooms.has(r.roomId)) continue; // 같은 방은 한 번에 하나
      busyRooms.add(r.roomId);
      const fallback = `⏰ ${r.text}`;
      const late = now - r.dueAt > LATE_MS ? formatLocal(r.dueAt) : undefined;
      const next = nextOccurrence(r.dueAt, r.repeat, now);
      if (!this.canGenerate()) {
        // 예산·한도로 생성할 수 없으면 고정 문구로 (리마인더를 잃지 않게)
        if (this.chat.postProactive(r.roomId, r.agentId, "reminder", fallback)) this.reminders.markFired(r, now, next);
        continue;
      }
      const started = this.chat.startProactive({
        roomId: r.roomId,
        agentId: r.agentId,
        part: { kind: "reminder", now: formatLocal(now), text: r.text, late },
        defaultModel: this.model(),
        query: r.text,
        fallback,
      });
      if (started === "busy" || started === "paused") continue; // 다음 tick 에
      this.reminders.markFired(r, now, next); // 생성 전에 기록 (도중에 꺼져도 다시 보내지 않게)
      if (typeof started !== "string") out.push(started);
      console.log(`[proactive] 리마인더 ${started === "not_found" ? "방 없음 — 버림" : "보냄"} repeat=${r.repeat}`);
    }
    return out;
  }

  private fireCheckins(now: number, st: Settings): Promise<unknown>[] {
    const out: Promise<unknown>[] = [];
    const today = localDate(now);
    const weekday = new Date(now).getDay();
    for (const agent of this.agents.agents()) {
      const c = agent.checkin;
      if (!c.enabled || !c.days.includes(weekday)) continue;
      const at = todayAt(now, c.time);
      if (now < at || this.agents.checkinLast(agent.id) === today) continue;
      // 방해 금지 시간이거나 너무 늦었으면 그날은 건너뛴다
      if (inQuiet(now, st.proactive) || now - at > CHECKIN_WINDOW_MS) {
        this.agents.setCheckinLast(agent.id, today);
        continue;
      }
      if (!this.canGenerate()) continue;
      const room = this.chat.soloRoom(agent.id);
      if (!room) continue;
      const started = this.chat.startProactive({
        roomId: room.id,
        agentId: agent.id,
        part: { kind: "checkin", now: formatLocal(now) },
        defaultModel: this.model(),
        query: "",
      });
      if (started === "busy" || started === "paused") continue;
      this.agents.setCheckinLast(agent.id, today);
      if (typeof started !== "string") out.push(started);
      console.log(`[proactive] 체크인 ${agent.name}`);
    }
    return out;
  }

  private fireNudge(now: number, st: Settings): Promise<unknown>[] {
    if (!st.proactive.nudgeEnabled || !this.canGenerate()) return [];
    const last = this.chat.lastUserActivity();
    if (!last) return [];
    const days = Math.floor((now - last.at) / DAY_MS);
    if (days < st.proactive.nudgeDays) return [];
    if (this.state(NUDGE_KEY) === String(last.at)) return []; // 이 침묵에 대해서는 이미 보냄
    const started = this.chat.startProactive({
      roomId: last.roomId,
      agentId: this.chat.lastSpeaker(last.roomId),
      part: { kind: "nudge", now: formatLocal(now), days },
      defaultModel: this.model(),
      query: "",
    });
    if (started === "busy" || started === "paused") return [];
    this.setState(NUDGE_KEY, String(last.at));
    console.log(`[proactive] 안부 days=${days}`);
    return typeof started === "string" ? [] : [started];
  }

  private state(key: string): string {
    return (
      this.db
        .query<{ value: string }, { key: string }>("SELECT value FROM scheduler_state WHERE key = $key")
        .get({ key })?.value ?? ""
    );
  }

  private setState(key: string, value: string) {
    this.db
      .query(
        "INSERT INTO scheduler_state (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run({ key, value });
  }
}
