// 리마인더: 이 방의 예약만
import { ReminderRepeat } from "@proprix/shared";
import { z } from "zod";
import { MAX_REMINDERS_PER_ROOM, type ReminderStore } from "../../proactive/reminders";
import { formatLocal, parseLocal } from "../../proactive/time";
import { define, type LocalTool, obj } from "./define";

const at = (ms: number) => formatLocal(ms);
const view = (x: { id: string; text: string; dueAt: number; repeat: string }) => ({
  id: x.id,
  text: x.text,
  when: at(x.dueAt),
  repeat: x.repeat,
});

export function reminderTools(reminders: ReminderStore, now: () => number): LocalTool[] {
  return [
    define({
      info: {
        name: "reminder_create",
        title: "리마인더 예약",
        description: "Schedule a reminder in this chat. At that time you will write a reminder message to the user.",
        kind: "write",
      },
      // 지금 시각을 알려 줘야 '내일 9시' 같은 말을 정확한 날짜로 바꿀 수 있다
      describe: () =>
        `Schedule a reminder in this chat. At that time you will write a reminder message to the user. Now: ${at(now())} (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Times are local.`,
      parameters: obj({
        text: { type: "string", description: "What to remind the user about, in the user's language." },
        when: { type: "string", description: "Local date and time, 'YYYY-MM-DD HH:MM'." },
        repeat: { type: "string", enum: ReminderRepeat.options },
      }),
      args: z.object({ text: z.string().trim().min(1).max(300), when: z.string(), repeat: ReminderRepeat }),
      trusted: true, // 확인 없이 (사용자 결정 2026-10-28) — 예약 목록에서 취소할 수 있다
      topLevelOnly: true,
      run: (a, ctx) => {
        const due = parseLocal(a.when);
        if (due === null) return { error: "when must be 'YYYY-MM-DD HH:MM' (local time)" };
        if (due < now() - 60_000) return { error: `that time has passed (now: ${at(now())})` };
        if (due > now() + 5 * 365 * 86_400_000) return { error: "too far in the future" };
        if (reminders.scheduled(ctx.roomId).length >= MAX_REMINDERS_PER_ROOM) return { error: "too many reminders" };
        const r = reminders.create({
          roomId: ctx.roomId,
          agentId: ctx.agent.id,
          text: a.text,
          dueAt: due,
          repeat: a.repeat,
        });
        return { scheduled: view(r) };
      },
    }),

    define({
      info: {
        name: "reminder_list",
        title: "리마인더 목록",
        description: "List the reminders scheduled in this chat.",
        kind: "read",
      },
      parameters: obj({}),
      args: z.object({}),
      topLevelOnly: true,
      run: (_a, ctx) => ({ now: at(now()), reminders: reminders.scheduled(ctx.roomId).map(view) }),
    }),

    define({
      info: {
        name: "reminder_cancel",
        title: "리마인더 취소",
        description: "Cancel a scheduled reminder in this chat by id. Use reminder_list first.",
        kind: "write",
      },
      parameters: obj({ id: { type: "string" } }),
      args: z.object({ id: z.string() }),
      trusted: true,
      topLevelOnly: true,
      run: (a, ctx) => {
        const r = reminders.get(a.id);
        if (!r || r.roomId !== ctx.roomId || r.status !== "scheduled") return { error: "reminder not found" };
        reminders.cancel(r.id);
        return { cancelled: r.id };
      },
    }),
  ];
}
