// 도구 호출 기록과 쓰기 도구 확인(승인) 대기
import type { Database } from "bun:sqlite";
import type { ToolCall } from "@proprix/shared";

interface CallRow {
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
}

const toCall = (r: CallRow): ToolCall => ({
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
});

export class ToolCallStore {
  constructor(private readonly db: Database) {
    // 이전 실행에서 끝나지 못한 호출 정리 (확인 대기·실행 중이던 것)
    db.query(
      "UPDATE tool_calls SET status = 'denied', reason = 'daemon_restarted' WHERE status IN ('pending', 'running')",
    ).run();
  }

  create(c: Omit<ToolCall, "id" | "createdAt" | "output" | "reason" | "preview"> & { preview?: string }): ToolCall {
    const call: ToolCall = {
      ...c,
      preview: c.preview ?? "",
      id: crypto.randomUUID(),
      output: "",
      reason: "",
      createdAt: Date.now(),
    };
    this.db
      .query(
        `INSERT INTO tool_calls (id, room_id, message_id, agent_id, parent_id, name, args, kind, status, output, reason,
         preview, created_at) VALUES ($id, $room, $message, $agent, $parent, $name, $args, $kind, $status, '', '', $preview,
         $created)`,
      )
      .run({
        id: call.id,
        room: call.roomId,
        message: call.messageId,
        agent: call.agentId,
        parent: call.parentId,
        name: call.name,
        args: call.args,
        kind: call.kind,
        status: call.status,
        preview: call.preview,
        created: call.createdAt,
      });
    return call;
  }

  update(call: ToolCall, patch: Partial<Pick<ToolCall, "status" | "output" | "reason">>): ToolCall {
    const next = { ...call, ...patch };
    this.db
      .query("UPDATE tool_calls SET status = $status, output = $output, reason = $reason WHERE id = $id")
      .run({ id: next.id, status: next.status, output: next.output, reason: next.reason });
    return next;
  }

  get(id: string): ToolCall | null {
    const r = this.db.query<CallRow, { id: string }>("SELECT * FROM tool_calls WHERE id = $id").get({ id });
    return r ? toCall(r) : null;
  }

  // 모든 방에서 확인을 기다리는 호출 (오래된 것부터)
  pending(): ToolCall[] {
    return this.db
      .query<CallRow, []>("SELECT * FROM tool_calls WHERE status = 'pending' ORDER BY created_at, rowid")
      .all()
      .map(toCall);
  }

  list(roomId: string): ToolCall[] {
    return this.db
      .query<CallRow, { room: string }>("SELECT * FROM tool_calls WHERE room_id = $room ORDER BY created_at, rowid")
      .all({ room: roomId })
      .map(toCall);
  }
}

export type Decision = "approve" | "deny" | "timeout" | "cancelled";

// 확인 대기: 사용자 결정·중지(signal)·시간 초과 중 먼저 오는 것으로 끝난다. 결정은 대기 중인 호출에 한 번만
export class ApprovalBroker {
  private readonly waiting = new Map<string, (d: Decision) => void>();

  wait(callId: string, signal: AbortSignal, timeoutMs: number): Promise<Decision> {
    return new Promise((resolve) => {
      const finish = (d: Decision) => {
        if (!this.waiting.has(callId)) return;
        this.waiting.delete(callId);
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(d);
      };
      const onAbort = () => finish("cancelled");
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      this.waiting.set(callId, finish);
      if (signal.aborted) finish("cancelled");
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // 대기 중이 아니면 false (이미 결정됨·없는 호출)
  decide(callId: string, approve: boolean): boolean {
    const finish = this.waiting.get(callId);
    if (!finish) return false;
    finish(approve ? "approve" : "deny");
    return true;
  }
}
