// 대화 중 시각화 (show_visual): 외부 주소 거절, SVG 형식 확인, 바깥 데이터가 든 턴 표시, 방 화자만
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Agent, AgentInput, DEFAULT_AGENT_TOOLS, VISUAL_TOOL } from "@proprix/shared";
import { AgentStore, DEFAULT_PERSONA_ID } from "../agents/store";
import { makeChatTools } from "../chat/test-helpers";
import { LlmGate } from "../llm/gate";
import { migrate } from "../storage/db";
import { externalUrl } from "./registry";

function setup() {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  const agents = new AgentStore(db);
  const agent = agents.createAgent(AgentInput.parse({ personaId: DEFAULT_PERSONA_ID, name: "A" })) as Agent;
  const llm = { stream: async () => ({}) as never };
  const tools = makeChatTools(db, llm, new LlmGate(db, () => {}), agents, () => {});
  return { registry: tools.registry, agent };
}

test("외부 주소: http(s)·프로토콜 상대 주소는 거절, SVG 이름공간은 허용", () => {
  expect(externalUrl('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toBeNull();
  expect(externalUrl('<img src="https://example.com/a.png">')).toBe("https://example.com/a.png");
  expect(externalUrl('<script src="//cdn.example.com/x.js"></script>')).toContain("//cdn.example.com");
  expect(externalUrl("// 주석\nconst x = 1;")).toBeNull();
});

test("실행: 보이기만 하고, 바깥 데이터가 든 턴이면 outside, 잘못된 입력은 실패로", async () => {
  const s = setup();
  const ctx = { agent: s.agent, roomId: "r" };
  const args = (content: string, format = "svg") => JSON.stringify({ title: "차트", format, content });
  const ok = await s.registry.run(
    VISUAL_TOOL,
    args('<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>'),
    ctx,
  );
  expect(ok).toEqual({ ok: true, output: JSON.stringify({ shown: true, outside: false }) });
  const outside = await s.registry.run(VISUAL_TOOL, args("<div>표</div>", "html"), { ...ctx, outside: true });
  expect(JSON.parse(outside.output)).toEqual({ shown: true, outside: true });

  const net = await s.registry.run(VISUAL_TOOL, args('<img src="https://x.test/p.png">', "html"), ctx);
  expect(net.ok).toBe(false);
  expect(net.output).toContain("external URL not allowed");
  const notSvg = await s.registry.run(VISUAL_TOOL, args("<div/>"), ctx);
  expect(notSvg).toMatchObject({ ok: false });
});

test("기본 도구에 들어 있고, 방 화자만 쓴다 (위임·작업자에서는 숨김)", () => {
  const s = setup();
  expect(DEFAULT_AGENT_TOOLS).toContain(VISUAL_TOOL);
  expect(s.registry.get(VISUAL_TOOL)?.kind).toBe("read");
  expect(s.registry.topLevelOnly(VISUAL_TOOL)).toBe(true);
});
