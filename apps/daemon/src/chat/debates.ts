// 토론·협업 기록 (진행은 ChatService 가 맡는다)
import type { Database } from "bun:sqlite";
import type { Debate, DebateMode } from "@proprix/shared";
import { parseIds } from "../storage/rows";

interface DebateRow {
  id: string;
  room_id: string;
  mode: DebateMode;
  topic: string;
  agent_ids: string;
  moderator_id: string;
  rounds: number;
  round: number;
  status: Debate["status"];
  error_code: string;
  created_at: number;
  updated_at: number;
}

const toDebate = (r: DebateRow): Debate => ({
  id: r.id,
  roomId: r.room_id,
  mode: r.mode,
  topic: r.topic,
  agentIds: parseIds(r.agent_ids),
  moderatorId: r.moderator_id,
  rounds: r.rounds,
  round: r.round,
  status: r.status,
  errorCode: r.error_code,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class DebateStore {
  constructor(private readonly db: Database) {
    // 이전 실행에서 끝나지 못한 토론
    db.query("UPDATE debates SET status = 'stopped', error_code = 'daemon_restarted' WHERE status = 'running'").run();
  }

  create(d: Pick<Debate, "roomId" | "mode" | "topic" | "agentIds" | "moderatorId" | "rounds">): Debate {
    const now = Date.now();
    const debate: Debate = {
      ...d,
      id: crypto.randomUUID(),
      round: 0,
      status: "running",
      errorCode: "",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        `INSERT INTO debates (id, room_id, mode, topic, agent_ids, moderator_id, rounds, round, status, error_code,
         created_at, updated_at)
         VALUES ($id, $room, $mode, $topic, $agents, $moderator, $rounds, 0, 'running', '', $now, $now)`,
      )
      .run({
        id: debate.id,
        room: d.roomId,
        mode: d.mode,
        topic: d.topic,
        agents: JSON.stringify(d.agentIds),
        moderator: d.moderatorId,
        rounds: d.rounds,
        now,
      });
    return debate;
  }

  update(debate: Debate, patch: Partial<Pick<Debate, "round" | "status" | "errorCode">>): Debate {
    const next = { ...debate, ...patch, updatedAt: Date.now() };
    this.db
      .query(
        "UPDATE debates SET round = $round, status = $status, error_code = $code, updated_at = $now WHERE id = $id",
      )
      .run({ id: next.id, round: next.round, status: next.status, code: next.errorCode, now: next.updatedAt });
    return next;
  }

  list(roomId: string): Debate[] {
    return this.db
      .query<DebateRow, { room: string }>("SELECT * FROM debates WHERE room_id = $room ORDER BY created_at")
      .all({ room: roomId })
      .map(toDebate);
  }
}
