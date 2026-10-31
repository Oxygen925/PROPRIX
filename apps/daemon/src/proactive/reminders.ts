// 리마인더 저장: 에이전트가 도구로 예약하고, 스케줄러가 시각이 되면 그 방에 메시지를 만든다
import type { Database } from "bun:sqlite";
import type { Reminder } from "@proprix/shared";

interface ReminderRow {
  id: string;
  room_id: string;
  agent_id: string;
  text: string;
  due_at: number;
  repeat: Reminder["repeat"];
  status: Reminder["status"];
  fired_count: number;
  last_fired_at: number | null;
  created_at: number;
}

const toReminder = (r: ReminderRow): Reminder => ({
  id: r.id,
  roomId: r.room_id,
  agentId: r.agent_id,
  text: r.text,
  dueAt: r.due_at,
  repeat: r.repeat,
  status: r.status,
  firedCount: r.fired_count,
  lastFiredAt: r.last_fired_at,
  createdAt: r.created_at,
});

export const MAX_REMINDERS_PER_ROOM = 50;

export class ReminderStore {
  constructor(
    private readonly db: Database,
    private readonly onChange: () => void = () => {},
  ) {}

  create(r: Pick<Reminder, "roomId" | "agentId" | "text" | "dueAt" | "repeat">): Reminder {
    const reminder: Reminder = {
      ...r,
      id: crypto.randomUUID(),
      status: "scheduled",
      firedCount: 0,
      lastFiredAt: null,
      createdAt: Date.now(),
    };
    this.db
      .query(
        `INSERT INTO reminders (id, room_id, agent_id, text, due_at, repeat, status, created_at)
         VALUES ($id, $room, $agent, $text, $due, $repeat, 'scheduled', $created)`,
      )
      .run({
        id: reminder.id,
        room: r.roomId,
        agent: r.agentId,
        text: r.text,
        due: r.dueAt,
        repeat: r.repeat,
        created: reminder.createdAt,
      });
    this.onChange();
    return reminder;
  }

  get(id: string): Reminder | null {
    const r = this.db.query<ReminderRow, { id: string }>("SELECT * FROM reminders WHERE id = $id").get({ id });
    return r ? toReminder(r) : null;
  }

  // 예약 중인 것 (roomId 가 있으면 그 방만), 가까운 순
  scheduled(roomId?: string): Reminder[] {
    return this.db
      .query<ReminderRow, { room: string }>(
        `SELECT * FROM reminders WHERE status = 'scheduled' AND ($room = '' OR room_id = $room) ORDER BY due_at`,
      )
      .all({ room: roomId ?? "" })
      .map(toReminder);
  }

  due(now: number): Reminder[] {
    return this.db
      .query<ReminderRow, { now: number }>(
        "SELECT * FROM reminders WHERE status = 'scheduled' AND due_at <= $now ORDER BY due_at",
      )
      .all({ now })
      .map(toReminder);
  }

  cancel(id: string): boolean {
    const changes = this.db
      .query("UPDATE reminders SET status = 'cancelled' WHERE id = $id AND status = 'scheduled'")
      .run({ id }).changes;
    if (changes) this.onChange();
    return changes > 0;
  }

  // 보내기 직전에 기록한다 (생성 중에 꺼져도 다시 보내지 않게). next 가 null 이면 끝
  markFired(r: Reminder, now: number, next: number | null) {
    this.db
      .query(
        `UPDATE reminders SET fired_count = fired_count + 1, last_fired_at = $now,
         status = $status, due_at = $due WHERE id = $id`,
      )
      .run({ id: r.id, now, status: next === null ? "done" : "scheduled", due: next ?? r.dueAt });
    this.onChange();
  }
}
