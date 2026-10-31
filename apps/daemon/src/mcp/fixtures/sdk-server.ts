// 테스트용 MCP 서버 (공식 SDK, stdio). FIXTURE_DESC 로 설명을 바꿔 '정의가 바뀐 서버'를 흉내 낸다.
// FIXTURE_MODERN=1 이면 serveStdio 로 2026-07-28 판도 받고, 아니면 2025 방식만
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

function make() {
  const server = new McpServer({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: process.env.FIXTURE_DESC ?? "Echo the text back.",
      inputSchema: z.object({ text: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
  );
  server.registerTool("fail", { description: "Always fails.", inputSchema: z.object({}) }, async () => ({
    isError: true,
    content: [{ type: "text", text: "boom" }],
  }));
  server.registerTool("env", { description: "Report environment.", inputSchema: z.object({}) }, async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          fake: process.env.FIXTURE_FAKE_SECRET ?? null,
          leaked: Object.keys(process.env).filter((k) => k.startsWith("PROPRIX_")),
        }),
      },
    ],
    structuredContent: { ok: true },
  }));
  return server;
}

if (process.env.FIXTURE_MODERN) serveStdio(make);
else await make().connect(new StdioServerTransport());
