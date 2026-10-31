// 반복 예약 작업 저장: 작업(일정·허용 도구)과 실행 기록. 저장할 때 일정·허용 도구를 검사하고 다음 실행 시각을 계산한다
import type { Database } from "bun:sqlite";
import {
  describeSchedule,
  nextRun,
  scheduleError,
  type Task,
  TaskInput,
  type TaskInput as TaskInputType,
  type TaskRun,
  TaskSchedule,
} from "@proprix/shared";

interface TaskRow {
  id: string;
  title: string;
  prompt: string;
  agent_id: string;
  room_id: string;
  schedule: string;
  allowed_tools: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  task_id: string;
  scheduled_for: number | null;
  started_at: number;
  ended_at: number | null;
  status: TaskRun["status"];
  reason: string;
  message_id: string;
  requests: number;
  rejected: number;
}

const toTask = (r: TaskRow): Task => {
  const schedule = TaskSchedule.parse(JSON.parse(r.schedule));
  return {
    id: r.id,
    title: r.title,
    prompt: r.prompt,
    agentId: r.agent_id,
    roomId: r.room_id,
    schedule,
    scheduleText: describeSchedule(schedule),
    allowedTools: JSON.parse(r.allowed_tools) as string[],
    enabled: r.enabled === 1,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

const toRun = (r: RunRow): TaskRun => ({
  id: r.id,
  taskId: r.task_id,
  scheduledFor: r.scheduled_for,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  status: r.status,
  reason: r.reason,
  messageId: r.message_id,
  requests: r.requests,
  rejected: r.rejected,
});

export type TaskError = { error: "invalid" | "not_found"; message: string };

// 저장할 때의 검사: 에이전트·방·도구는 바깥에서 (app 에서 연결)
export interface TaskChecks {
  agentInRoom(agentId: string, roomId: string): boolean;
  // 허용 목록에 넣을 수 없는 도구면 사유 ("" = 괜찮음)
  toolError(agentId: string, tool: string): string;
}

const RUNS_KEEP = 200; // 작업마다 남길 실행 기록

export class TaskStore {
  checks: TaskChecks = { agentInRoom: () => true, toolError: () => "" };

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly onChange: () => void = () => {},
  ) {}

  list(roomId?: string): Task[] {
    const rows = roomId
      ? this.db
          .query<TaskRow, { room: string }>("SELECT * FROM tasks WHERE room_id = $room ORDER BY created_at")
          .all({ room: roomId })
      : this.db.query<TaskRow, []>("SELECT * FROM tasks ORDER BY created_at").all();
    return rows.map(toTask);
  }

  get(id: string): Task | null {
    const r = this.db.query<TaskRow, { id: string }>("SELECT * FROM tasks WHERE id = $id").get({ id });
    return r ? toTask(r) : null;
  }

  /** 검사 후 저장할 값 (다음 실행 시각 포함). 오류면 TaskError */
  check(raw: TaskInputType, prev?: Task): (ReturnType<typeof TaskInput.parse> & { next: number | null }) | TaskError {
    const p = TaskInput.safeParse(raw);
    if (!p.success) return { error: "invalid", message: p.error.issues[0]?.message ?? "형식 오류" };
    const t = p.data;
    const now = this.now();
    // N시간마다는 기준 시각을 정해 둔다 (일정을 그대로 두면 이전 기준을 지킨다)
    if (t.schedule.kind === "interval") {
      const old =
        prev?.schedule.kind === "interval" && prev.schedule.hours === t.schedule.hours
          ? prev.schedule.anchor
          : undefined;
      t.schedule = { ...t.schedule, anchor: old ?? now };
    }
    const bad = scheduleError(t.schedule, now);
    if (bad) return { error: "invalid", message: bad };
    if (!this.checks.agentInRoom(t.agentId, t.roomId))
      return { error: "invalid", message: "그 에이전트가 있는 채팅이 아닙니다" };
    t.allowedTools = [...new Set(t.allowedTools)];
    for (const tool of t.allowedTools) {
      const e = this.checks.toolError(t.agentId, tool);
      if (e) return { error: "invalid", message: e };
    }
    return { ...t, next: t.enabled ? nextRun(t.schedule, now) : null };
  }

  create(raw: TaskInputType, createdBy = "user"): Task | TaskError {
    const v = this.check(raw);
    if ("error" in v) return v;
    const id = crypto.randomUUID();
    const now = this.now();
    this.db
      .query(
        `INSERT INTO tasks (id, title, prompt, agent_id, room_id, schedule, allowed_tools, enabled, next_run_at,
         created_by, created_at, updated_at)
         VALUES ($id, $title, $prompt, $agent, $room, $schedule, $tools, $enabled, $next, $by, $now, $now)`,
      )
      .run({
        id,
        title: v.title,
        prompt: v.prompt,
        agent: v.agentId,
        room: v.roomId,
        schedule: JSON.stringify(v.schedule),
        tools: JSON.stringify(v.allowedTools),
        enabled: v.enabled ? 1 : 0,
        next: v.next,
        by: createdBy,
        now,
      });
    this.onChange();
    return this.get(id) as Task;
  }

  update(id: string, raw: TaskInputType): Task | TaskError {
    const prev = this.get(id);
    if (!prev) return { error: "not_found", message: "없는 작업" };
    const v = this.check(raw, prev);
    if ("error" in v) return v;
    this.db
      .query(
        `UPDATE tasks SET title = $title, prompt = $prompt, agent_id = $agent, room_id = $room, schedule = $schedule,
         allowed_tools = $tools, enabled = $enabled, next_run_at = $next, updated_at = $now WHERE id = $id`,
      )
      .run({
        id,
        title: v.title,
        prompt: v.prompt,
        agent: v.agentId,
        room: v.roomId,
        schedule: JSON.stringify(v.schedule),
        tools: JSON.stringify(v.allowedTools),
        enabled: v.enabled ? 1 : 0,
        next: v.next,
        now: this.now(),
      });
    this.onChange();
    return this.get(id) as Task;
  }

  delete(id: string): boolean {
    const n = this.db.query("DELETE FROM tasks WHERE id = $id").run({ id }).changes;
    if (n) this.onChange();
    return n > 0;
  }

  /** 지운 MCP 서버의 도구를 모든 작업의 허용 목록에서 뺀다 (같은 이름으로 다시 만든 다른 서버가 물려받지 않게) */
  revokeToolPrefix(prefix: string) {
    const p = prefix.toLowerCase();
    let changed = false;
    for (const t of this.list()) {
      const left = t.allowedTools.filter((n) => !n.toLowerCase().startsWith(p));
      if (left.length === t.allowedTools.length) continue;
      this.db
        .query("UPDATE tasks SET allowed_tools = $tools, updated_at = $now WHERE id = $id")
        .run({ id: t.id, tools: JSON.stringify(left), now: this.now() });
      changed = true;
    }
    if (changed) this.onChange();
  }

  /** 지금까지 예정 시각이 된 켜진 작업 */
  due(now: number): Task[] {
    return this.db
      .query<TaskRow, { now: number }>(
        "SELECT * FROM tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= $now ORDER BY next_run_at",
      )
      .all({ now })
      .map(toTask);
  }

  /** 다음 예정 시각을 after 이후로 넘긴다 (놓친 회차는 건너뛴다) */
  advance(id: string, after: number) {
    const t = this.get(id);
    if (!t) return;
    this.db
      .query("UPDATE tasks SET next_run_at = $next WHERE id = $id")
      .run({ id, next: t.enabled ? nextRun(t.schedule, after) : null });
    this.onChange();
  }

  // ---- 실행 기록 ----

  startRun(taskId: string, scheduledFor: number | null): TaskRun {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO task_runs (id, task_id, scheduled_for, started_at, status) VALUES ($id, $task, $for, $now, 'running')`,
      )
      .run({ id, task: taskId, for: scheduledFor, now: this.now() });
    this.db.query("UPDATE tasks SET last_status = 'running' WHERE id = $id").run({ id: taskId });
    this.onChange();
    return this.run(id) as TaskRun;
  }

  /** 건너뛴 회차 기록 (실행하지 않음) */
  skipRun(taskId: string, scheduledFor: number, reason: string) {
    const r = this.startRun(taskId, scheduledFor);
    this.finishRun(r.id, { status: "skipped", reason });
  }

  finishRun(
    id: string,
    p: { status: TaskRun["status"]; reason?: string; messageId?: string; requests?: number; rejected?: number },
  ) {
    const now = this.now();
    this.db
      .query(
        `UPDATE task_runs SET status = $status, reason = $reason, message_id = $msg, requests = $req, rejected = $rej,
         ended_at = $now WHERE id = $id`,
      )
      .run({
        id,
        status: p.status,
        reason: p.reason ?? "",
        msg: p.messageId ?? "",
        req: p.requests ?? 0,
        rej: p.rejected ?? 0,
        now,
      });
    const run = this.run(id);
    if (run) {
      this.db
        .query("UPDATE tasks SET last_status = $status, last_run_at = $at WHERE id = $id")
        .run({ id: run.taskId, status: p.status, at: run.startedAt });
      // 오래된 기록 정리
      this.db
        .query(
          `DELETE FROM task_runs WHERE task_id = $task AND id NOT IN
           (SELECT id FROM task_runs WHERE task_id = $task ORDER BY started_at DESC LIMIT $keep)`,
        )
        .run({ task: run.taskId, keep: RUNS_KEEP });
    }
    this.onChange();
  }

  run(id: string): TaskRun | null {
    const r = this.db.query<RunRow, { id: string }>("SELECT * FROM task_runs WHERE id = $id").get({ id });
    return r ? toRun(r) : null;
  }

  runs(taskId: string, limit = 50): TaskRun[] {
    return this.db
      .query<RunRow, { task: string; limit: number }>(
        "SELECT * FROM task_runs WHERE task_id = $task ORDER BY started_at DESC LIMIT $limit",
      )
      .all({ task: taskId, limit })
      .map(toRun);
  }

  /** 이 방의 예약 작업 결과 메시지 → 작업 (화면이 메시지 머리에 작업 제목을 보인다) */
  messages(roomId: string): { messageId: string; taskId: string; title: string }[] {
    return this.db
      .query<{ messageId: string; taskId: string; title: string }, { room: string }>(
        `SELECT r.message_id AS messageId, t.id AS taskId, t.title AS title FROM task_runs r
         JOIN tasks t ON t.id = r.task_id WHERE t.room_id = $room AND r.message_id != ''`,
      )
      .all({ room: roomId });
  }

  /** daemon 이 꺼지며 끝나지 못한 실행은 실패로 */
  closeStale() {
    const n = this.db
      .query("UPDATE task_runs SET status = 'failed', reason = 'interrupted', ended_at = $now WHERE status = 'running'")
      .run({ now: this.now() }).changes;
    if (n) {
      this.db.query("UPDATE tasks SET last_status = 'failed' WHERE last_status = 'running'").run();
      this.onChange();
    }
  }
}
