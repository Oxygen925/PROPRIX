// LlmGate: 사용자 플랜으로 나가는 모든 LLM 호출이 지나가는 관문.
// 동시성 상한, 사용량 한도(429)에서 전역 일시정지(사용자가 재개해야 풀림 — 리셋 시각을 추정하지 않는다), 사용량 장부,
// 기능별 일일 요청 수 상한(로컬 자정 기준, 진행 중인 요청 포함 — 동시에 들어온 요청이 상한을 넘지 않게).
import type { Database } from "bun:sqlite";
import {
  BUDGET_FEATURES,
  type BudgetFeature,
  type Budgets,
  type LlmFeature,
  type LlmStatus,
  type UsageAlert,
  type UsageHistory,
} from "@proprix/shared";
import { failedResult, type StreamResult } from "../auth/account";
import { localDate } from "../proactive/time";

export type { LlmFeature };

export const BUDGET_EXCEEDED = "daily_budget_exceeded";

// 오늘 로컬 자정 (ms)
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const SLOT_MS = 15 * 60_000;

const isBudgeted = (f: LlmFeature): f is BudgetFeature => f !== "preview";

export class LlmGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private paused = false;
  private pausedCode = "";
  private readonly inflight = new Map<LlmFeature, number>();
  // 예산 80%·100% 에 닿을 때 (app 이 이벤트로 보낸다)
  onUsageAlert: (a: UsageAlert) => void = () => {};

  constructor(
    private readonly db: Database,
    private readonly onStatus: (s: LlmStatus) => void,
    private readonly concurrency = 2,
    private readonly budgets: () => Budgets | null = () => null, // null = 상한 없음 (테스트 기본)
    private readonly now: () => number = Date.now,
  ) {}

  // 오늘 보낸 요청 수 (진행 중 포함)
  used(feature: LlmFeature): number {
    const row = this.db
      .query<{ n: number }, { feature: string; since: number }>(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE feature = $feature AND started_at >= $since",
      )
      .get({ feature, since: startOfDay(this.now()) });
    return (row?.n ?? 0) + (this.inflight.get(feature) ?? 0);
  }

  // 오늘 남은 요청 수. null = 무제한
  remaining(feature: LlmFeature): number | null {
    const limit = isBudgeted(feature) ? (this.budgets()?.[feature] ?? null) : null;
    return limit === null ? null : Math.max(0, limit - this.used(feature));
  }

  usageToday(): { since: number; features: { feature: string; used: number; limit: number | null }[] } {
    const b = this.budgets();
    const features = BUDGET_FEATURES.map((f) => ({
      feature: f,
      used: this.used(f),
      limit: b?.[f] ?? null,
    }));
    return { since: startOfDay(this.now()), features };
  }

  // 최근 days 일(오늘 포함)의 로컬 날짜·기능별 요청 수
  history(days: number): UsageHistory {
    const d = new Date(startOfDay(this.now()));
    d.setDate(d.getDate() - (days - 1));
    const since = d.getTime();
    // 날짜는 일일 예산(startOfDay)과 같은 JS 로컬 시간대로 나눈다 — SQLite 'localtime' 은 시간대가 다를 수 있다.
    // SQL 에서는 15분 칸으로만 묶어 행 수를 줄인다 (30·45분 시차도 칸 경계가 날짜 경계와 맞는다)
    const rows = this.db
      .query<{ slot: number; feature: string; count: number }, { since: number }>(
        `SELECT started_at / ${SLOT_MS} AS slot, feature, COUNT(*) AS count
         FROM usage_ledger WHERE started_at >= $since GROUP BY slot, feature`,
      )
      .all({ since });
    const sums = new Map<string, { date: string; feature: string; count: number }>();
    for (const r of rows) {
      const date = localDate(r.slot * SLOT_MS);
      const key = `${date}|${r.feature}`;
      const cur = sums.get(key);
      if (cur) cur.count += r.count;
      else sums.set(key, { date, feature: r.feature, count: r.count });
    }
    const out = [...sums.values()].sort((a, b) => a.date.localeCompare(b.date) || a.feature.localeCompare(b.feature));
    return { since, days: out };
  }

  // 기록을 넣은 뒤: 오늘 기록 수가 예산의 80%(올림)·100% 에 정확히 닿으면 알린다.
  // 닿는 순간에만 보내므로 따로 상태를 두지 않아도 기능마다 하루 한 번이고, 재시작해도 겹치지 않는다
  private checkBudget(feature: LlmFeature) {
    if (!isBudgeted(feature)) return;
    const limit = this.budgets()?.[feature] ?? null;
    if (limit === null) return;
    const used =
      this.db
        .query<{ n: number }, { feature: string; since: number }>(
          "SELECT COUNT(*) AS n FROM usage_ledger WHERE feature = $feature AND started_at >= $since",
        )
        .get({ feature, since: startOfDay(this.now()) })?.n ?? 0;
    const level = used === limit ? 100 : used === Math.ceil(limit * 0.8) ? 80 : null;
    if (level) this.onUsageAlert({ feature, used, limit, level });
  }

  status(): LlmStatus {
    return { paused: this.paused, pausedCode: this.pausedCode, active: this.active, queued: this.waiting.length };
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.pausedCode = "";
    this.onStatus(this.status());
  }

  async run(feature: LlmFeature, model: string, fn: () => Promise<StreamResult>): Promise<StreamResult> {
    if (this.paused) return pausedResult(this.pausedCode);
    if (this.remaining(feature) === 0) {
      console.warn(`[llm] 오늘 ${feature} 예산을 다 씀 — 요청하지 않음`);
      return budgetResult();
    }
    this.inflight.set(feature, (this.inflight.get(feature) ?? 0) + 1);
    try {
      return await this.runCounted(feature, model, fn);
    } finally {
      this.inflight.set(feature, (this.inflight.get(feature) ?? 1) - 1);
    }
  }

  private async runCounted(feature: LlmFeature, model: string, fn: () => Promise<StreamResult>): Promise<StreamResult> {
    await this.acquire();
    this.onStatus(this.status());
    try {
      if (this.paused) return pausedResult(this.pausedCode); // 기다리는 동안 한도에 걸렸을 수 있다
      const started = this.now();
      const t0 = Date.now();
      const r = await fn();
      this.db
        .query(
          `INSERT INTO usage_ledger (feature, model, outcome, code, attempts, chars, duration_ms, started_at)
           VALUES ($feature, $model, $outcome, $code, $attempts, $chars, $duration, $started)`,
        )
        .run({
          feature,
          model,
          outcome: r.outcome,
          code: r.code,
          attempts: r.attempts,
          chars: r.chars,
          duration: Date.now() - t0,
          started,
        });
      this.checkBudget(feature);
      if (r.recovery === "usage_limit") {
        this.paused = true;
        this.pausedCode = r.code || "usage_limit";
        console.warn(`[llm] 사용량 한도 — 새 요청 중지 (code=${this.pausedCode})`);
      }
      return r;
    } finally {
      this.release();
      this.onStatus(this.status());
    }
  }

  private async acquire() {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    // 깨어날 때는 release 가 슬롯을 그대로 넘겨준다 (active 는 이미 세어져 있음).
    // 줄였다가 다시 늘리면 그 사이에 새 요청이 끼어들어 상한을 넘을 수 있다
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}

const budgetResult = () => failedResult(BUDGET_EXCEEDED, "none");
const pausedResult = (code: string) => failedResult(code || "usage_limit", "usage_limit");
