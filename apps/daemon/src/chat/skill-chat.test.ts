// Skill 이 대화 흐름에서: 켠 에이전트만 목록·도구, /이름 으로 부르면 그 턴만 본문, 스크립트는 명령 실행 켠 방에서 늘 확인
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Agent, AgentInput, type ServerEvent, type ToolCall } from "@proprix/shared";
import type { AiRequest } from "@proprix/siwc";
import { AgentStore, DEFAULT_PERSONA_ID } from "../agents/store";
import type { StreamOptions, StreamResult } from "../auth/account";
import { SummaryService } from "../context/summary";
import { LlmGate } from "../llm/gate";
import { Runners } from "../skills/runners";
import { SkillService } from "../skills/service";
import { migrate } from "../storage/db";
import { ChatService } from "./chat";
import { makeChatTools } from "./test-helpers";

let base: string;
let root: string;
const runners = new Runners(); // 실제 PATH (PowerShell 은 Windows 에 늘 있다)
beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "proprix-skc-"));
  root = join(base, "project");
  mkdirSync(root);
  await runners.check();
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
  const skills = new SkillService(db, mkdtempSync(join(base, "skills-")), runners);
  const summaries = new SummaryService(db, llm, gate, emit, () => "a");
  const tools = makeChatTools(db, llm, gate, agents, emit, {
    snapshotsDir: join(base, `snap-${Math.random()}`),
    skills,
  });
  const chat = new ChatService(db, llm, gate, agents, summaries, tools, emit);
  chat.skills = skills;
  const agent = agents.createAgent(
    AgentInput.parse({ personaId: DEFAULT_PERSONA_ID, name: "봇", tools: ["current_time"], ...patch }),
  ) as Agent;
  const room = chat.createRoom("s", [agent.id]);
  if (typeof room === "string") throw new Error(room);
  const install = (name: string, body: string, extra: Record<string, string> = {}) => {
    const files = { "SKILL.md": `---\nname: ${name}\ndescription: ${name} 설명\n---\n${body}`, ...extra };
    const { zipSync, strToU8 } = require("fflate") as typeof import("fflate");
    const data = Buffer.from(
      zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))),
    ).toString("base64");
    skills.commit(skills.stage({ kind: "zip", fileName: "s.zip", data }).id);
  };
  const calls = () =>
    events.filter((e): e is Extract<ServerEvent, { type: "tool" }> => e.type === "tool").map((e) => e.call);
  const lastCall = (): ToolCall | undefined => calls().at(-1);
  return { chat, room, requests, calls, lastCall, agent, agents, install };
}

async function until(pred: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await Bun.sleep(5);
  }
}
const toolNames = (req?: AiRequest) => (req?.tools ?? []).map((t) => (t.type === "function" ? t.name : t.type));
const outputs = (req: AiRequest) => (req.items ?? []).filter((i) => i.type === "function_call_output");

test("켜지 않은 에이전트에게는 skill 목록·도구가 없고, 켠 에이전트는 목록과 읽기 도구를 받는다 (스크립트는 명령 실행 켠 방에서만)", async () => {
  const s = setup(() => null);
  s.install("report", "보고서 쓰는 법");
  s.chat.send(s.room.id, "안녕", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  expect(toolNames(s.requests[0]).some((n) => n.startsWith("skill_"))).toBe(false);
  expect(s.requests[0]?.instructions).not.toContain("# Skills");

  s.agents.updateAgent(s.agent.id, AgentInput.parse({ ...s.agent, skills: ["REPORT"] }));
  s.chat.send(s.room.id, "다시", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  const names = toolNames(s.requests.at(-1));
  expect(names).toEqual(expect.arrayContaining(["skill_load", "skill_read_file"]));
  expect(names).not.toContain("skill_run_script");
  expect(s.requests.at(-1)?.instructions).toContain('- "report": report 설명');
  expect(s.requests.at(-1)?.instructions).not.toContain("보고서 쓰는 법"); // 본문은 skill_load 로

  s.chat.updateRoom(s.room.id, { workspace: root, shellEnabled: true });
  s.chat.send(s.room.id, "또", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  expect(toolNames(s.requests.at(-1))).toContain("skill_run_script");
});

test("/이름 으로 부르면 켜지 않은 에이전트도 그 턴만 본문·인자를 받고 skill_load 를 쓸 수 있다", async () => {
  const s = setup((req) =>
    outputs(req).length === 0 && req.instructions?.includes("# Skill invoked")
      ? [fc("skill_load", { name: "report" })]
      : null,
  );
  s.install("report", "보고서 쓰는 법", { "ref/guide.md": "참고" });
  s.chat.send(s.room.id, "/Report 3분기 매출", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  const first = s.requests[0];
  expect(first?.instructions).toContain('# Skill invoked by the user: "report"');
  expect(first?.instructions).toContain("보고서 쓰는 법");
  expect(first?.instructions).toContain("3분기 매출");
  const load = s.calls().findLast((c) => c.name === "skill_load");
  expect(load?.status).toBe("done");
  expect(load?.output).toContain("ref/guide.md");

  // 다음 턴에는 다시 없다
  s.chat.send(s.room.id, "고마워", "m");
  await until(() => !s.chat.room(s.room.id)?.running);
  expect(toolNames(s.requests.at(-1)).some((n) => n.startsWith("skill_"))).toBe(false);
});

test("스크립트: 명령 실행 켠 방에서 늘 확인, 항상 허용 규칙은 생기지 않고, 인자는 배열로 넘어간다", async () => {
  const s = setup(
    (req) =>
      outputs(req).length === 0
        ? [
            fc("skill_run_script", {
              name: "tool",
              script: "scripts/hi.ps1",
              args: ["a b", "'q'"],
              cwd: null,
              timeout_sec: 30,
            }),
          ]
        : null,
    { autoApproveWrites: true, skills: ["tool"] },
  );
  s.install("tool", "스크립트 쓰는 법", { "scripts/hi.ps1": 'Write-Output "한글-ok:$($args[0])|$($args[1])"' });
  s.chat.updateRoom(s.room.id, { workspace: root, shellEnabled: true });
  s.chat.send(s.room.id, "실행해", "m");
  await until(() => s.lastCall()?.status === "pending" || s.lastCall()?.status === "failed", 10_000);
  expect(s.lastCall()).toMatchObject({ name: "skill_run_script", status: "pending" });
  expect(s.lastCall()?.preview).toContain("스크립트: scripts/hi.ps1");
  expect(s.lastCall()?.preview).toContain("실행기:");
  s.chat.decide(s.lastCall()?.id ?? "", true, true);
  expect(s.agents.agent(s.agent.id)?.autoApproveTools).toEqual([]);
  await until(() => !s.chat.room(s.room.id)?.running, 30_000);
  expect(s.calls().findLast((c) => c.name === "skill_run_script")?.output).toContain("한글-ok:a b|'q'");
}, 40_000);
