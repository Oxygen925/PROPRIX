// 자율 대화 스케줄러: 설정이 켜져 있으면 허용 시간대 안에서 하루 횟수만큼 라운지 세션을 연다 (기본 꺼짐).
// 남은 횟수를 남은 허용 시간에 흩뜨린다 — 매 tick 시작할 확률 = 남은 횟수 / 남은 tick 수. 놓친 세션을 몰아서 하지 않는다.
import type { LoungeSession, LoungeStatus, Settings } from "@proprix/shared";
import type { z } from "zod";
import { startOfDay } from "../llm/gate";
import { pickModel } from "../llm/model";
import type { ChatService } from "./chat";

export interface LoungeOptions {
  tickMs: number;
  minGapMs: number; // 세션 사이 최소 간격
  now: () => number;
  random: () => number;
}

export const DEFAULT_LOUNGE_OPTIONS: LoungeOptions = {
  tickMs: 60_000,
  minGapMs: 60 * 60_000,
  now: Date.now,
  random: Math.random,
};

export type LoungeStart = ReturnType<ChatService["startLounge"]>;

export class LoungeScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly chat: ChatService,
    private readonly settings: () => Settings,
    private readonly opt: LoungeOptions = DEFAULT_LOUNGE_OPTIONS,
  ) {}

  start() {
    this.timer = setInterval(() => this.tick(), this.opt.tickMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  status(): z.infer<typeof LoungeStatus> {
    return {
      roomId: this.chat.loungeRoom()?.id ?? "",
      sessionsToday: this.chat.lounges.countScheduledSince(startOfDay(this.opt.now())),
      recent: this.chat.lounges.recent(10),
    };
  }

  // '지금 실행': 켜짐·시간대·하루 횟수와 관계없이 (예산·진행 중 여부는 지킨다)
  runNow(model: string): LoungeSession | Exclude<LoungeStart, LoungeSession> {
    const l = this.settings().lounge;
    return this.chat.startLounge(l.agentIds, l.turns, model, true, this.opt.random);
  }

  // 시작했으면 세션, 조건이 안 맞으면 null, 시도했다 못 했으면 사유
  tick(): LoungeStart | "no_model" | null {
    const st = this.settings();
    const l = st.lounge;
    if (!l.enabled) return null;
    const now = this.opt.now();
    const hour = new Date(now).getHours();
    if (hour < l.startHour || hour >= l.endHour) return null;
    const left = l.perDay - this.chat.lounges.countScheduledSince(startOfDay(now));
    if (left <= 0) return null;
    const last = this.chat.lounges.lastStartedAt();
    if (last !== null && now - last < this.opt.minGapMs) return null;
    const end = new Date(now);
    end.setHours(l.endHour, 0, 0, 0);
    const ticksLeft = Math.max(1, (end.getTime() - now) / this.opt.tickMs);
    if (this.opt.random() >= left / ticksLeft) return null;

    const model = pickModel(st, () => this.chat.lastModel());
    if (!model) return "no_model";
    const r = this.chat.startLounge(l.agentIds, l.turns, model, false, this.opt.random);
    if (typeof r === "string") console.log(`[lounge] 자율 대화 건너뜀: ${r}`);
    else console.log(`[lounge] 자율 대화 시작 agents=${r.agentIds.length} turns=${r.turns}`);
    return r;
  }
}
