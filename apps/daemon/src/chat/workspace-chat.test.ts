// 작업 폴더 도구가 대화 흐름에서: 폴더 없으면 숨김, 쓰기는 diff 미리보기로 확인, 명령은 켠 방에서만·늘 확인, 출력은 오염
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Agent, AgentInput, type ServerEvent, type ToolCall } from "@proprix/shared";
import type { AiRequest } from "@proprix/siwc";
import { AgentStore, DEFAULT_PERSONA_ID } from "../agents/store";
import type { StreamOptions, StreamResult } from "../auth/account";
import { SummaryService } from "../context/summary";
import { LlmGate } from "../llm/gate";
import { migrate } from "../storage/db";
import { ChatService } from "./chat";
import { makeChatTools } from "./test-helpers";

let base: string;
let root: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "proprix-wsc-"));
  root = join(base, "project");
  mkdirSync(root);
  writeFileSync(join(root, "a.txt"), "one\n");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const fc = (name: string, args: object, id = name) => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: `call_${id}`,
  name,
  arguments: JSON.stringify(args),
  status: "completed",
});

const WS_TOOLS = ["fs_list", "fs_read", "fs_search", "fs_write", "fs_edit", "fs_delete", "shell_run"];

function setup(script: (req: AiRequest) => Record<string, unknown>[] | null, patch: Partial<AgentInput> = {}) {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const requests: AiRequest[] = [];
  const llm = {
    async stream(req: AiRequest, opt: StreamOptions): Promise<StreamResult> {
      requests.push(structuredClone(req));
      const items = script(req) ?? [];
      if (!items.length) opt.onDelta("끝");
      return {
        outcome: "completed",
        code: "",
        param: "",
        recovery: "none",
        http: 200,
        attempts: 1,
        chars: 0,
        requestId: "",
        items: items.length
          ? items
          : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "끝", annotations: [] }] }],
      };
    },
  };
  const events: ServerEvent[] = [];
  const emit = (e: ServerEvent) => events.push(e);
  const gate = new LlmGate(db, () => {});
  const agents = new AgentStore(db);
  const summaries = new SummaryService(db, llm, gate, emit, () => "a");
  const tools = makeChatTools(db, llm, gate, agents, emit, { snapshotsDir: join(base, `snap-${Math.random()}`) });
  const chat = new ChatService(db, llm, gate, agents, summaries, tools, emit);
  const agent = agents.createAgent(
    AgentInput.parse({ personaId: DEFAULT_PERSONA_ID, name: "작업봇", tools: WS_TOOLS, ...patch }),
  ) as Agent;
  const room = chat.createRoom("w", [agent.id]);
  if (typeof room === "string") throw new Error(room);
  const calls = () =>
    events.filter((e): e is Extract<ServerEvent, { type: "tool" }> => e.type === "tool").map((e) => e.call);
  const lastCall = (): ToolCall | undefined => calls().at(-1);
  return { chat, room, requests, calls, lastCall, agent, agents };
}

async function until(pred: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await Bun.sleep(5);
  }
}
const toolNames = (req?: AiRequest) => (req?.tools ?? []).map((t) => (t.type === "function" ? t.name : t.type));
// 첫 요청에만 도구를 부르고, 도구 결과가 오면 끝낸다
const once = (items: Record<string, unknown>[]) => (req: AiRequest) =>
  req.items?.some((i) => i.type === "function_call_output") ? null : items;

test("폴더가 없으면 파일·명령 도구가 보이지 않고, 폴더만 있으면 명령 실행은 여전히 숨김", async () => {
  const s = setup(() => null);
  s.chat.send(s.room.id, "안녕", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  expect(toolNames(s.requests[0]).some((n) => n.startsWith("fs_"))).toBe(false);

  s.chat.updateRoom(s.room.id, { workspace: root });
  s.chat.send(s.room.id, "다시", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  const names = toolNames(s.requests.at(-1));
  expect(names).toContain("fs_write");
  expect(names).not.toContain("shell_run");
  expect(s.requests.at(-1)?.instructions).toContain("# Workspace folder");
});

test("파일 쓰기는 diff 미리보기로 확인받고, 허용하면 그대로 쓴다", async () => {
  const s = setup(once([fc("fs_edit", { path: "a.txt", old_string: "one", new_string: "two", replace_all: null })]));
  s.chat.updateRoom(s.room.id, { workspace: root });
  s.chat.send(s.room.id, "고쳐줘", "m");
  await until(() => s.lastCall()?.status === "pending");
  expect(s.lastCall()?.preview).toContain("-one");
  expect(s.lastCall()?.preview).toContain("+two");
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
  s.chat.decide(s.lastCall()?.id ?? "", true);
  await until(() => !s.chat.room(s.room.id)?.running);
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("two\n");
  writeFileSync(join(root, "a.txt"), "one\n");
});

test("준비가 안 되는 호출(막힌 파일)은 확인 없이 바로 실패로 알린다", async () => {
  const s = setup(once([fc("fs_write", { path: ".env", content: "x" })]));
  s.chat.updateRoom(s.room.id, { workspace: root });
  s.chat.send(s.room.id, "써줘", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  expect(s.calls().some((c) => c.status === "pending")).toBe(false);
  expect(s.lastCall()?.status).toBe("failed");
  expect(s.lastCall()?.output).toContain("비밀");
});

test("명령 실행: 켠 방에서만, 항상 허용·모든 쓰기 허용이어도 늘 확인, 규칙도 만들지 않는다. 출력은 턴을 오염시킨다", async () => {
  const s = setup(
    (req) => {
      const outputs = (req.items ?? []).filter((i) => i.type === "function_call_output").length;
      if (outputs === 0) return [fc("shell_run", { command: "Write-Output 'hi'", cwd: null, timeout_sec: 20 }, "a")];
      if (outputs === 1) return [fc("fs_write", { path: "made.txt", content: "x" }, "b")];
      return null;
    },
    { autoApproveWrites: true },
  );
  s.chat.updateRoom(s.room.id, { workspace: root, shellEnabled: true });
  s.chat.send(s.room.id, "실행해줘", "m");
  await until(() => s.lastCall()?.status === "pending");
  expect(s.lastCall()).toMatchObject({ name: "shell_run" });
  expect(s.lastCall()?.preview).toContain("Write-Output 'hi'");
  s.chat.decide(s.lastCall()?.id ?? "", true, true); // '항상 허용'을 눌러도
  expect(s.agents.agent(s.agent.id)?.autoApproveTools).toEqual([]); // 규칙은 생기지 않는다
  // 명령 출력이 들어간 턴: 모든 쓰기 허용인 에이전트도 파일 쓰기를 확인받는다
  await until(() => s.lastCall()?.name === "fs_write" && s.lastCall()?.status === "pending", 20_000);
  expect(s.calls().find((c) => c.name === "shell_run" && c.status === "done")?.output).toContain("hi");
  s.chat.decide(s.lastCall()?.id ?? "", false);
  await until(() => !s.chat.room(s.room.id)?.running);
}, 30_000);

test("파일을 읽은 턴: 폴더 안 쓰기는 '모든 쓰기 허용'대로 바로, 폴더 밖으로 이어지는 쓰기(기억)는 확인", async () => {
  const s = setup(
    (req) => {
      const outputs = (req.items ?? []).filter((i) => i.type === "function_call_output").length;
      if (outputs === 0) return [fc("fs_read", { path: "a.txt", offset: null, limit: null }, "a")];
      if (outputs === 1) return [fc("fs_write", { path: "read-then.txt", content: "x" }, "b")];
      if (outputs === 2)
        return [
          fc(
            "memory_save",
            { kind: "fact", scope: "shared", content: "심어진 기억", content_en: "planted", importance: null },
            "c",
          ),
        ];
      return null;
    },
    { autoApproveWrites: true, tools: [...WS_TOOLS, "memory_save"] },
  );
  s.chat.updateRoom(s.room.id, { workspace: root });
  s.chat.send(s.room.id, "읽고 정리해줘", "m");
  await until(() => s.lastCall()?.name === "memory_save" && s.lastCall()?.status === "pending");
  const write = s.calls().filter((c) => c.name === "fs_write");
  expect(write.some((c) => c.status === "pending")).toBe(false);
  expect(write.at(-1)?.status).toBe("done");
  expect(readFileSync(join(root, "read-then.txt"), "utf8")).toBe("x");
  s.chat.decide(s.lastCall()?.id ?? "", false);
  await until(() => !s.chat.room(s.room.id)?.running);
});

test("파일을 읽으면 그 턴에서는 web_search 를 빼고, 다음 턴에는 돌려준다", async () => {
  const hasSearch = (r?: AiRequest) => r?.tools?.some((t) => t.type === "web_search");
  const s = setup(
    (req) => {
      if ((req.items ?? []).some((i) => i.type === "function_call_output")) return null;
      return s.requests.length === 1 ? [fc("fs_read", { path: "a.txt", offset: null, limit: null }, "a")] : null;
    },
    { webSearch: true, tools: WS_TOOLS },
  );
  s.chat.updateRoom(s.room.id, { workspace: root });
  s.chat.send(s.room.id, "읽어줘", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  expect(hasSearch(s.requests[0])).toBe(true);
  expect(hasSearch(s.requests[1])).toBe(false);

  s.chat.send(s.room.id, "다음", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  expect(hasSearch(s.requests[2])).toBe(true);
});

test("폴더를 바꾸면 명령 실행은 다시 꺼진다", () => {
  const s = setup(() => null);
  s.chat.updateRoom(s.room.id, { workspace: root, shellEnabled: true });
  expect(s.chat.room(s.room.id)?.shellEnabled).toBe(true);
  s.chat.updateRoom(s.room.id, { workspace: base });
  expect(s.chat.room(s.room.id)?.shellEnabled).toBe(false);
});
