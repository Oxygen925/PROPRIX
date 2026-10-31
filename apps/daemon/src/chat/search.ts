// 대화 검색 (검색 화면): 메시지 원문에서 글자 그대로 찾는다 (한글 2글자 검색도 되게 LIKE)
import type { Database } from "bun:sqlite";
import type { SearchResult } from "@proprix/shared";

export interface SearchQuery {
  q: string;
  roomId?: string;
  agentId?: string; // 그 에이전트가 참여한 방
  from?: number; // 이 시각부터
  to?: number; // 이 시각 전까지
  limit?: number;
}

const SNIPPET = 60; // 찾은 곳 앞뒤 글자 수

interface Row {
  id: string;
  room_id: string;
  room_title: string;
  role: "user" | "assistant";
  agent_id: string;
  content: string;
  created_at: number;
}

export function snippetOf(content: string, q: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return flat.slice(0, SNIPPET * 2);
  const start = Math.max(0, at - SNIPPET);
  const end = Math.min(flat.length, at + q.length + SNIPPET);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export function searchMessages(db: Database, s: SearchQuery): { results: SearchResult[]; more: boolean } {
  const q = s.q.trim();
  if (!q) return { results: [], more: false };
  const limit = Math.min(Math.max(s.limit ?? 50, 1), 200);
  const where = ["m.content LIKE $pat ESCAPE '\\'", "m.content != ''"];
  const params: Record<string, string | number> = {
    pat: `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    limit: limit + 1,
  };
  if (s.roomId) {
    where.push("m.room_id = $room");
    params.room = s.roomId;
  }
  if (s.agentId) {
    where.push("m.room_id IN (SELECT room_id FROM room_members WHERE agent_id = $agent)");
    params.agent = s.agentId;
  }
  if (s.from !== undefined) {
    where.push("m.created_at >= $from");
    params.from = s.from;
  }
  if (s.to !== undefined) {
    where.push("m.created_at < $to");
    params.to = s.to;
  }
  const rows = db
    .query<Row, Record<string, string | number>>(
      `SELECT m.id, m.room_id, r.title AS room_title, m.role, m.agent_id, m.content, m.created_at
       FROM messages m JOIN rooms r ON r.id = m.room_id
       WHERE ${where.join(" AND ")}
       ORDER BY m.created_at DESC LIMIT $limit`,
    )
    .all(params);
  return {
    more: rows.length > limit,
    results: rows.slice(0, limit).map((r) => ({
      messageId: r.id,
      roomId: r.room_id,
      roomTitle: r.room_title,
      role: r.role,
      agentId: r.agent_id,
      snippet: snippetOf(r.content, q),
      createdAt: r.created_at,
    })),
  };
}
