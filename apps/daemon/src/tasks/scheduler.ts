// 반복 예약 작업 스케줄러: 예정 시각이 된 작업을 실행한다 (선제 메시지 스케줄러와 같은 틀).
// - 놓친 회차(PC 꺼짐·잠자기·방이 계속 응답 중)는 건너뛴다: 예정 시각에서 missMs 가 지나면 기록 하나 남기고 다음 회차로
// - 전역 일시정지(429)·예산 소진·모델 없음이면 그 회차를 건너뛴다
// - 방해 금지 시간대에도 실행한다 (알림만 화면에서 미룬다 — 사용자 결정 2026-10-29)
import type { Settings, TaskRun } from "@proprix/shared";
import type { ChatService } from "../chat/chat";
import type { LlmGate } from "../llm/gate";
import { pickModel } from "../llm/model";
import type { TaskStore } from "./store";

export interface TaskSchedulerOptions {
  tickMs: number;
  missMs: number; // 예정 시각에서 이만큼 지나도록 시작하지 못하면 건너뜀
  now: () => number;
}

export const DEFAULT_TASK_OPTIONS: TaskSchedulerOptions = { tickMs: 30_000, missMs: 10 * 60_000, now: Date.now };

export type RunNowError = "not_found" | "running" | "busy" | "paused" | "no_model";

export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly running = new Set<string>(); // 실행 중인 작업 id
  private readonly busy = new Set<string>(); // 방이 응답 중이라 기다리는 작업 id

  constructor(
    private readonly store: TaskStore,
    private readonly chat: ChatService,
    private readonly gate: LlmGate,
    private readonly settings: () => Settings,
    private readonly opt: TaskSchedulerOptions = DEFAULT_TASK_OPTIONS,
  ) {}

  start() {
    this.store.closeStale();
    this.timer = setInterval(() => void this.tick(), this.opt.tickMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  private model(): string {
    return pickModel(this.settings(), () => this.chat.lastModel());
  }

  // 한 번 훑는다. 테스트가 실행이 끝날 때까지 기다릴 수 있게 Promise 를 모아 돌려준다
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const pending: Promise<unknown>[] = [];
    try {
      const now = this.opt.now();
      for (const task of this.store.due(now)) {
        if (this.running.has(task.id)) continue;
        const due = task.nextRunAt ?? now;
        const skip = (reason: string) => {
          this.busy.delete(task.id);
          this.store.skipRun(task.id, due, reason);
          this.store.advance(task.id, now);
        };
        if (now - due > this.opt.missMs) {
          skip(this.busy.has(task.id) ? "busy" : "missed");
          continue;
        }
        if (this.gate.status().paused) {
          skip("paused");
          continue;
        }
        if (this.gate.remaining("tasks") === 0) {
          skip("budget");
          continue;
        }
        if (!this.model()) {
          skip("no_model");
          continue;
        }
        const r = this.execute(task.id, due);
        if (r === "busy")
          this.busy.add(task.id); // 다음 tick 에 다시 (missMs 까지)
        else if (typeof r === "string") skip(r);
        else {
          this.busy.delete(task.id);
          this.store.advance(task.id, now);
          pending.push(r);
        }
      }
    } finally {
      this.ticking = false;
    }
    await Promise.all(pending);
  }

  /** '지금 실행': 다음 예정 시각은 그대로 둔다 */
  runNow(id: string): Promise<TaskRun | null> | RunNowError {
    if (!this.store.get(id)) return "not_found";
    if (this.running.has(id)) return "running";
    if (!this.model()) return "no_model";
    const r = this.execute(id, null);
    return typeof r === "string" ? (r as RunNowError) : r;
  }

  private execute(id: string, scheduledFor: number | null): Promise<TaskRun | null> | "busy" | "paused" | "not_found" {
    const task = this.store.get(id);
    if (!task) return "not_found";
    const started = this.chat.startTask({
      roomId: task.roomId,
      agentId: task.agentId,
      title: task.title,
      prompt: task.prompt,
      allowedTools: task.allowedTools,
      defaultModel: this.model(),
    });
    if (typeof started === "string") return started;
    this.running.add(id);
    const run = this.store.startRun(id, scheduledFor);
    return started
      .then((o) => {
        this.store.finishRun(run.id, o);
        return this.store.run(run.id);
      })
      .catch((err) => {
        console.error("[tasks] 실행 예외", err);
        this.store.finishRun(run.id, { status: "failed", reason: "error" });
        return this.store.run(run.id);
      })
      .finally(() => this.running.delete(id));
  }
}
