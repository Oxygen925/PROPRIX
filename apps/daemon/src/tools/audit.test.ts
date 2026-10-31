// 도구 실행 감사 로그 (P10b): 모든 방의 쓰기 호출만 최신순, 묶음·상태·방 필터, 커서, 메모·리마인더 되돌리기
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "@proprix/shared";
import { ReminderStore } from "../proactive/reminders";
import { migrate } from "../storage/db";
import { AuditService } from "./audit";
import { ToolCallStore } from "./calls";
import { FileChangeStore } from "./files";
import { NoteStore } from "./notes";

function setup() {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  const now = Date.now();
  const rooms: [string, string][] = [
    ["r1", "방 하나"],
    ["r2", "방 둘"],
  ];
  for (const [id, title] of rooms)
    db.query("INSERT INTO rooms (id, title, created_at, updated_at) VALUES ($id, $title, $now, $now)").run({
      id,
      title,
      now,
    });
  const calls = new ToolCallStore(db);
  const notes = new NoteStore(db);
  const reminders = new ReminderStore(db);
  const changes = new FileChangeStore(db, mkdtempSync(join(tmpdir(), "proprix-audit-")));
  const audit = new AuditService(db, changes, notes, reminders, () => 42);
  let t = 1000;
  // 만든 시각을 차례로 (같은 ms 에 여러 개가 들어가도 순서가 정해지게 일부는 같은 시각)
  const call = (roomId: string, name: string, patch: Partial<ToolCall> = {}, kind: ToolCall["kind"] = "write") => {
    const c = calls.create({
      roomId,
      messageId: "m",
      agentId: "a",
      parentId: "",
      name,
      args: "{}",
      kind,
      status: "done",
    });
    calls.update(c, { status: patch.status ?? "done", output: patch.output ?? "", reason: "" });
    db.query("UPDATE tool_calls SET created_at = $t WHERE id = $id").run({ id: c.id, t: patch.createdAt ?? t++ });
    return c.id;
  };
  return { db, audit, notes, reminders, call };
}

test("쓰기 호출만 최신순, 방 제목, 묶음·상태·방 필터, 커서로 빠짐없이 이어 받기", () => {
  const s = setup();
  s.call("r1", "memory_search", {}, "read");
  const ids = [
    s.call("r1", "fs_write"),
    s.call("r2", "note_create", { output: "{}" }),
    s.call("r1", "mcp__fx__echo"),
    s.call("r2", "shell_run", { status: "denied" }),
    s.call("r1", "memory_save", { createdAt: 5000 }),
    s.call("r2", "reminder_create", { createdAt: 5000 }),
  ];
  const all = s.audit.list({ limit: 100 });
  expect(all.items).toHaveLength(6);
  expect(all.items.map((x) => x.name).slice(2)).toEqual(["shell_run", "mcp__fx__echo", "note_create", "fs_write"]);
  expect(all.items.find((x) => x.name === "fs_write")?.roomTitle).toBe("방 하나");
  expect(all.next).toBeNull();

  const group = (g: Parameters<AuditService["list"]>[0]["group"]) =>
    s.audit.list({ group: g, limit: 100 }).items.map((x) => x.name);
  expect(group("file")).toEqual(["fs_write"]);
  expect(group("mcp")).toEqual(["mcp__fx__echo"]);
  expect(group("command")).toEqual(["shell_run"]);
  expect(group("other")).toEqual(["memory_save"]);
  expect(s.audit.list({ status: "denied", limit: 100 }).items.map((x) => x.name)).toEqual(["shell_run"]);
  expect(s.audit.list({ roomId: "r2", limit: 100 }).items).toHaveLength(3);

  // 1개씩: 같은 시각(5000) 두 개가 쪽 경계에 걸려도 빠지거나 겹치지 않는다
  const seen: string[] = [];
  let before = "";
  for (let i = 0; i < 10; i++) {
    const page = s.audit.list({ before, limit: 1 });
    seen.push(...page.items.map((x) => x.id));
    if (!page.next) break;
    before = page.next;
  }
  expect(seen.sort()).toEqual([...ids].sort());
});

test("되돌리기: 도구가 만든 메모는 지우고 리마인더는 취소, 다시 하면 already, 그 밖은 not_undoable", () => {
  const s = setup();
  const note = s.notes.create({ title: "장보기", body: "" }, "a");
  const rem = s.reminders.create({
    roomId: "r1",
    agentId: "a",
    text: "물 마시기",
    dueAt: Date.now() + 60_000,
    repeat: "none",
  });
  const n = s.call("r1", "note_create", { output: JSON.stringify({ created: note.id }) });
  const r = s.call("r1", "reminder_create", { output: JSON.stringify({ scheduled: { id: rem.id, text: rem.text } }) });
  const f = s.call("r1", "fs_write");
  const failed = s.call("r1", "note_create", { status: "failed" });

  const entry = (id: string) => s.audit.list({ limit: 100 }).items.find((x) => x.id === id);
  expect(entry(n)?.undo).toEqual({ kind: "note", targetId: note.id, label: "장보기", available: true });
  expect(entry(r)?.undo).toMatchObject({ kind: "reminder", label: "물 마시기", available: true });
  expect(entry(f)?.undo).toBeNull();
  expect(entry(failed)?.undo).toBeNull();

  expect(s.audit.undo(n)).toBe("ok");
  expect(s.notes.get(note.id)).toBeNull();
  expect(entry(n)).toMatchObject({ undoneAt: 42, undo: { available: false, label: "" } });
  expect(s.audit.undo(n)).toBe("already");

  expect(s.audit.undo(r)).toBe("ok");
  expect(s.reminders.get(rem.id)?.status).toBe("cancelled");
  expect(s.audit.undo(r)).toBe("already");

  expect(s.audit.undo(f)).toBe("not_undoable");
  expect(s.audit.undo("missing")).toBe("not_found");

  // 사용자가 이미 지운 메모는 되돌릴 것이 없다
  const gone = s.notes.create({ title: "x", body: "" }, "a");
  const g = s.call("r1", "note_create", { output: JSON.stringify({ created: gone.id }) });
  s.notes.delete(gone.id);
  expect(entry(g)?.undo?.available).toBe(false);
  expect(s.audit.undo(g)).toBe("already");
});
