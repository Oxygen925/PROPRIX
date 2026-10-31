// 자율 대화(라운지) 세션 기록
import type { Database } from "bun:sqlite";
import type { LoungeSession } from "@proprix/shared";
import { parseIds } from "../storage/rows";

interface SessionRow {
  id: string;
  room_id: string;
  agent_ids: string;
  turns: number;
  spoken: number;
  manual: number;
  status: LoungeSession["status"];
  error_code: string;
  started_at: number;
  ended_at: number | null;
}

const toSession = (r: SessionRow): LoungeSession => ({
  id: r.id,
  roomId: r.room_id,
  agentIds: parseIds(r.agent_ids),
  turns: r.turns,
  spoken: r.spoken,
  manual: r.manual === 1,
  status: r.status,
  errorCode: r.error_code,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

export class LoungeStore {
  constructor(private readonly db: Database) {
    db.query(
      "UPDATE lounge_sessions SET status = 'stopped', error_code = 'daemon_restarted' WHERE status = 'running'",
    ).run();
  }

  create(s: Pick<LoungeSession, "roomId" | "agentIds" | "turns" | "manual">, now: number): LoungeSession {
    const session: LoungeSession = {
      ...s,
      id: crypto.randomUUID(),
      spoken: 0,
      status: "running",
      errorCode: "",
      startedAt: now,
      endedAt: null,
    };
    this.db
      .query(
        `INSERT INTO lounge_sessions (id, room_id, agent_ids, turns, spoken, manual, status, error_code, started_at)
         VALUES ($id, $room, $agents, $turns, 0, $manual, 'running', '', $now)`,
      )
      .run({
        id: session.id,
        room: s.roomId,
        agents: JSON.stringify(s.agentIds),
        turns: s.turns,
        manual: s.manual ? 1 : 0,
        now,
      });
    return session;
  }

  update(s: LoungeSession, patch: Partial<Pick<LoungeSession, "spoken" | "status" | "errorCode" | "endedAt">>) {
    const next = { ...s, ...patch };
    this.db
      .query(
        `UPDATE lounge_sessions SET spoken = $spoken, status = $status, error_code = $code, ended_at = $ended
         WHERE id = $id`,
      )
      .run({ id: next.id, spoken: next.spoken, status: next.status, code: next.errorCode, ended: next.endedAt });
    return next;
  }

  // 자동으로 시작한 세션 수 ('지금 실행'은 하루 횟수에 넣지 않는다)
  countScheduledSince(since: number): number {
    return (
      this.db
        .query<{ n: number }, { since: number }>(
          "SELECT COUNT(*) AS n FROM lounge_sessions WHERE manual = 0 AND started_at >= $since",
        )
        .get({ since })?.n ?? 0
    );
  }

  lastStartedAt(): number | null {
    return this.db.query<{ t: number | null }, []>("SELECT MAX(started_at) AS t FROM lounge_sessions").get()?.t ?? null;
  }

  recent(limit: number): LoungeSession[] {
    return this.db
      .query<SessionRow, { limit: number }>("SELECT * FROM lounge_sessions ORDER BY started_at DESC LIMIT $limit")
      .all({ limit })
      .map(toSession);
  }
}
