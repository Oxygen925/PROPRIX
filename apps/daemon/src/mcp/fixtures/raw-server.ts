// 테스트용 옛 MCP 서버 (손으로 쓴 JSON-RPC, stdio). initialize·tools/list·tools/call 만 알고 모르는 요청에는 답하지 않는다
const out = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (m.method === "initialize")
      out({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "raw", version: "0.1" },
        },
      });
    else if (m.method === "tools/list")
      out({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          tools: [
            {
              name: "args",
              description: "Return the process arguments.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
    else if (m.method === "tools/call")
      out({
        jsonrpc: "2.0",
        id: m.id,
        result: { content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }] },
      });
    // 그 밖(server/discover·ping 등)은 답하지 않는다 — 실제 옛 서버들처럼
  }
});
