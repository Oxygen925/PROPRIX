// 도구 실행 감사 로그 (P10b): 모든 방의 쓰기 도구 호출을 한곳에서 보고 되돌린다 (사용자 결정 2026-10-29).
// 되돌릴 수 있는 것: 파일 변경(스냅샷 복원 — FileChangeStore.restore), 도구가 만든 메모(삭제)·리마인더(취소).
// 메모 수정·삭제, MCP, 명령은 기록만. 방을 지우면 그 방의 기록도 함께 지워진다 (tool_calls ON DELETE CASCADE)
import type { Database } from "bun:sqlite";
import {
  type AuditEntry,
  type AuditPage,
  type AuditUndo,
  COMMAND_TOOLS,
  type ToolCall,
  type ToolGroup,
} from "@proprix/shared";
import type { ReminderStore } from "../proactive/reminders";
import type { FileChangeStore } from "./files";
import type { NoteStore } from "./notes";

export const AUDIT_PAGE_MAX = 100;

export interface AuditQuery {
  roomId?: string;
  group?: ToolGroup;
  status?: ToolCall["status"];
  before?: string; // 이전 쪽의 next ("created_at:rowid")
  limit: number;
}

export type UndoResult = "ok" | "already" | "not_undoable" | "not_found";

interface Row {
  rowid: number;
  id: string;
  room_id: string;
  message_id: string;
  agent_id: string;
  parent_id: string;
  name: string;
  args: string;
  kind: ToolCall["kind"];
  status: ToolCall["status"];
  output: string;
  reason: string;
  preview: string;
  created_at: number;
  undone_at: number | null;
  room_title: string | null;
}

// 도구 묶음 → SQL 조건 (이름 규칙은 shared toolGroup 과 같다)
const PREFIX: Partial<Record<ToolGroup, string>> = {
  file: "fs\\_%",
  note: "note\\_%",
  reminder: "reminder\\_%",
  mcp: "mcp\\_\\_%",
};
const COMMANDS = COMMAND_TOOLS.map((n) => `'${n}'`).join(", ");
function groupSql(g: ToolGroup): string {
  const prefix = PREFIX[g];
  if (prefix) return `c.name LIKE '${prefix}' ESCAPE '\\'`;
  if (g === "command") return `c.name IN (${COMMANDS})`;
  return `NOT (${Object.values(PREFIX)
    .map((p) => `c.name LIKE '${p}' ESCAPE '\\'`)
    .join(" OR ")} OR c.name IN (${COMMANDS}))`;
}

function parseOutput(output: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(output);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class AuditService {
  constructor(
    private readonly db: Database,
    private readonly changes: FileChangeStore,
    private readonly notes: NoteStore,
    private readonly reminders: ReminderStore,
    private readonly now: () => number = Date.now,
  ) {}

  list(q: AuditQuery): AuditPage {
    const where = ["c.kind = 'write'"];
    const params: Record<string, string | number> = { limit: q.limit + 1 };
    if (q.roomId) {
      where.push("c.room_id = $room");
      params.room = q.roomId;
    }
    if (q.group) where.push(groupSql(q.group));
    if (q.status) {
      where.push("c.status = $status");
      params.status = q.status;
    }
    const cursor = /^(\d+):(\d+)$/.exec(q.before ?? "");
    if (cursor) {
      where.push("(c.created_at < $t OR (c.created_at = $t AND c.rowid < $r))");
      params.t = Number(cursor[1]);
      params.r = Number(cursor[2]);
    }
    const rows = this.db
      .query<Row, Record<string, string | number>>(
        `SELECT c.rowid AS rowid, c.*, r.title AS room_title FROM tool_calls c LEFT JOIN rooms r ON r.id = c.room_id
         WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC, c.rowid DESC LIMIT $limit`,
      )
      .all(params);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    const changes = this.changes.forCalls(page.map((r) => r.id));
    return {
      items: page.map((r) =>
        this.entry(
          r,
          changes.filter((c) => c.callId === r.id),
        ),
      ),
      next: rows.length > q.limit && last ? `${last.created_at}:${last.rowid}` : null,
    };
  }

  // 도구가 만든 메모는 지우고, 리마인더는 취소한다. 파일은 /file-changes/:id/restore
  undo(callId: string): UndoResult {
    const row = this.row(callId);
    if (!row) return "not_found";
    const u = this.undoOf(row);
    if (!u) return "not_undoable";
    if (!u.available) return "already";
    const ok = u.kind === "note" ? this.notes.delete(u.targetId) : this.reminders.cancel(u.targetId);
    if (!ok) return "already";
    this.db.query("UPDATE tool_calls SET undone_at = $now WHERE id = $id").run({ id: callId, now: this.now() });
    return "ok";
  }

  private row(id: string): Row | null {
    return this.db
      .query<Row, { id: string }>(
        `SELECT c.rowid AS rowid, c.*, r.title AS room_title FROM tool_calls c LEFT JOIN rooms r ON r.id = c.room_id
         WHERE c.id = $id`,
      )
      .get({ id });
  }

  private undoOf(r: Row): AuditUndo | null {
    if (r.status !== "done") return null;
    const out = parseOutput(r.output);
    if (r.name === "note_create" && typeof out?.created === "string") {
      const note = this.notes.get(out.created);
      return { kind: "note", targetId: out.created, label: note?.title ?? "", available: !!note && !r.undone_at };
    }
    const scheduled = out?.scheduled as { id?: unknown } | undefined;
    if (r.name === "reminder_create" && typeof scheduled?.id === "string") {
      const rem = this.reminders.get(scheduled.id);
      return {
        kind: "reminder",
        targetId: scheduled.id,
        label: rem?.text ?? "",
        available: rem?.status === "scheduled" && !r.undone_at,
      };
    }
    return null;
  }

  private entry(r: Row, changes: AuditEntry["changes"]): AuditEntry {
    return {
      id: r.id,
      roomId: r.room_id,
      messageId: r.message_id,
      agentId: r.agent_id,
      parentId: r.parent_id,
      name: r.name,
      args: r.args,
      kind: r.kind,
      status: r.status,
      output: r.output,
      reason: r.reason,
      preview: r.preview,
      createdAt: r.created_at,
      roomTitle: r.room_title ?? "",
      undoneAt: r.undone_at,
      changes,
      undo: this.undoOf(r),
    };
  }
}
