// 리서치 반복 예약 (P11c): 예약 작업 스케줄러와 같은 틀.
// - 예약 실행은 이 리서치에서 예전에 읽은 주소를 건너뛴다 (새로 읽은 관련 페이지가 없으면 글을 쓰지 않고 'skipped')
// - 놓친 회차(PC 꺼짐·잠자기·앞 실행이 아직 도는 중)는 예정 시각에서 missMs 가 지나면 기록 하나 남기고 다음 회차로
// - 일시정지·예산·모델·브라우저 없음이면 그 회차를 건너뛴다
// - 방해 금지 시간대에도 실행한다 (알림만 화면에서 미룬다)
import type { ServerEvent } from "@proprix/shared";
import type { ResearchRunner } from "./runner";
import type { ResearchStore } from "./store";

export interface ResearchSchedulerOptions {
  tickMs: number;
  missMs: number;
  now: () => number;
}

export const DEFAULT_RESEARCH_SCHEDULE: ResearchSchedulerOptions = {
  tickMs: 30_000,
  missMs: 10 * 60_000,
  now: Date.now,
};

export class ResearchScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly store: ResearchStore,
    private readonly runner: ResearchRunner,
    private readonly emit: (e: ServerEvent) => void,
    private readonly opt: ResearchSchedulerOptions = DEFAULT_RESEARCH_SCHEDULE,
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), this.opt.tickMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  // 한 번 훑는다. 테스트가 실행이 끝날 때까지 기다릴 수 있게 Promise 를 모아 돌려준다
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const pending: Promise<void>[] = [];
    try {
      const now = this.opt.now();
      for (const r of this.store.due(now)) {
        const due = r.nextRunAt ?? now;
        const skip = (reason: string) => {
          this.emit({ type: "research_run", run: this.store.skipRun(r.id, reason) });
          this.store.advance(r.id, now);
          this.emit({ type: "research" });
        };
        if (now - due > this.opt.missMs) {
          skip(this.runner.isRunning(r.id) ? "running" : "missed");
          continue;
        }
        if (this.runner.isRunning(r.id)) continue; // '지금 실행'이 도는 중: 다음 tick 에 다시 (missMs 까지)
        const started = this.runner.start(r.id, { skipSeen: true });
        if (typeof started === "string") {
          if (started !== "not_found") skip(started);
          continue;
        }
        this.store.advance(r.id, now);
        this.emit({ type: "research" });
        pending.push(started.done);
      }
    } finally {
      this.ticking = false;
    }
    await Promise.all(pending);
  }
}
