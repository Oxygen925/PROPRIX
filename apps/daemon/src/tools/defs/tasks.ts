// 반복 예약 작업 (P8): 이 방·이 에이전트의 작업만. 만들기는 늘 확인 (일정·지시·허용 도구를 보고)
import { describeSchedule, TaskSchedule, upcoming } from "@proprix/shared";
import { z } from "zod";
import { formatLocal } from "../../proactive/time";
import type { TaskStore } from "../../tasks/store";
import { WorkspaceError } from "../workspace";
import { define, type LocalTool, nullable, obj, type ToolContext } from "./define";

export function taskTools(tasks: TaskStore): LocalTool[] {
  const inRoom = (ctx: ToolContext, id: string) => {
    const t = tasks.get(id);
    if (!t || t.roomId !== ctx.roomId) throw new WorkspaceError("이 채팅의 작업이 아닙니다");
    return t;
  };
  const schedule = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "time", "days", "day", "hours", "cron"],
    properties: {
      kind: { type: "string", enum: ["daily", "weekly", "monthly", "interval", "cron"] },
      time: nullable("string", "HH:MM local time for daily/weekly/monthly. null otherwise."),
      days: {
        type: ["array", "null"],
        items: { type: "integer" },
        description: "weekly: 0=Sun..6=Sat. null otherwise.",
      },
      day: nullable("integer", "monthly: day of month 1-31 (last day if the month is shorter). null otherwise."),
      hours: nullable("integer", "interval: every N hours (>= 1). null otherwise."),
      cron: nullable("string", "cron: 5-field expression (min hour dom month dow), local time. null otherwise."),
    },
  };

  return [
    define({
      info: {
        name: "task_create",
        title: "예약 작업 생성",
        description:
          "Create a recurring scheduled task in this room: at the scheduled times you will do the instruction with your tools while the user is away, then report here. Runs must be at least 1 hour apart. allowed_tools lists write tools you may use without confirmation during runs (others are refused); command execution is never allowed. The user always reviews it first.",
        kind: "write",
        alwaysConfirm: true,
      },
      topLevelOnly: true,
      parameters: obj({
        title: { type: "string", description: "Short title." },
        instruction: { type: "string", description: "What to do at each run, written for yourself." },
        schedule,
        allowed_tools: { type: "array", items: { type: "string" }, description: "Write tool names (may be empty)." },
      }),
      args: z.object({
        title: z.string().min(1).max(80),
        instruction: z.string().min(1).max(8000),
        schedule: z.object({
          kind: z.enum(["daily", "weekly", "monthly", "interval", "cron"]),
          time: z.string().nullable(),
          days: z.array(z.number().int()).nullable(),
          day: z.number().int().nullable(),
          hours: z.number().int().nullable(),
          cron: z.string().nullable(),
        }),
        allowed_tools: z.array(z.string()).max(30),
      }),
      prepare: (a, ctx) => {
        const parsed = TaskSchedule.safeParse({
          kind: a.schedule.kind,
          time: a.schedule.time ?? undefined,
          days: a.schedule.days ?? undefined,
          day: a.schedule.day ?? undefined,
          hours: a.schedule.hours ?? undefined,
          cron: a.schedule.cron ?? undefined,
        });
        if (!parsed.success) throw new WorkspaceError(`일정 형식 오류: ${parsed.error.issues[0]?.message ?? ""}`);
        const input = {
          title: a.title,
          prompt: a.instruction,
          agentId: ctx.agent.id,
          roomId: ctx.roomId,
          schedule: parsed.data,
          allowedTools: a.allowed_tools,
        };
        const v = tasks.check(input);
        if ("error" in v) throw new WorkspaceError(v.message);
        const next = upcoming(v.schedule, Date.now(), 3).map(formatLocal);
        return {
          preview: [
            `작업: ${v.title}`,
            `일정: ${describeSchedule(v.schedule)} — 다음: ${next.join(", ")}`,
            `확인 없이 할 쓰기 도구: ${v.allowedTools.length ? v.allowedTools.join(", ") : "(없음 — 쓰기는 모두 거절)"}`,
            "",
            v.prompt,
          ].join("\n"),
          state: input,
        };
      },
      run: (_a, ctx, p) => {
        const t = tasks.create(p, ctx.agent.id);
        if ("error" in t) throw new WorkspaceError(t.message);
        return {
          ok: true,
          id: t.id,
          schedule: t.scheduleText,
          next_run: t.nextRunAt ? formatLocal(t.nextRunAt) : null,
        };
      },
    }),
    define({
      info: {
        name: "task_list",
        title: "예약 작업 목록",
        description: "List the scheduled tasks of this room.",
        kind: "read",
      },
      parameters: obj({}),
      args: z.object({}),
      run: (_a, ctx) =>
        tasks.list(ctx.roomId).map((t) => ({
          id: t.id,
          title: t.title,
          schedule: t.scheduleText,
          enabled: t.enabled,
          next_run: t.nextRunAt ? formatLocal(t.nextRunAt) : null,
          last_status: t.lastStatus || null,
        })),
    }),
    define({
      info: {
        name: "task_delete",
        title: "예약 작업 삭제",
        description: "Delete a scheduled task of this room.",
        kind: "write",
      },
      parameters: obj({ id: { type: "string" } }),
      args: z.object({ id: z.string().min(1) }),
      prepare: (a, ctx) => {
        const t = inRoom(ctx, a.id);
        return { preview: `작업 삭제: ${t.title} (${t.scheduleText})`, state: null };
      },
      run: (a, ctx) => {
        inRoom(ctx, a.id);
        return { ok: tasks.delete(a.id) };
      },
    }),
  ];
}
