// MCP 연결 관리: 필요할 때 연결하고 쓰지 않으면 끊는다 (사용자 결정 2026-10-29).
// - 클라이언트 capabilities 는 비운다 (sampling·roots·elicitation 없음 → 서버 요청은 SDK 가 거절)
// - 버전 협상은 자동 (2026-07-28 먼저, 아니면 2025 방식). 2026 판의 입력 요구(input_required)는 채우지 않고 오류로
// - stdio: 사용자가 등록한 명령만, 인자 배열, 환경 변수는 정리한 것 + 사용자 env. 끊을 때 프로세스 트리까지 끝낸다
// - http: https(로컬은 http) · 같은 출처 리다이렉트만 · Streamable HTTP 가 안 되면 SSE
// - 호출 직전에 도구 정의가 고정한 것과 같은지 다시 본다
import { homedir } from "node:os";
import { Client, SSEClientTransport, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MCP_PREFIX, type McpServerInfo, type McpToolInfo, mcpUrlError, type ToolInfo } from "@proprix/shared";
import type { FunctionTool } from "@proprix/siwc";
import { scrubEnv } from "../tools/exec-policy";
import { formatResult, normalizeSchema } from "./schema";
import type { McpStore, ServerRow, ToolRow } from "./store";

export interface McpOptions {
  idleMs: number; // 쓰지 않으면 끊기
  connectTimeoutMs: number; // 처음 npx 는 오래 걸릴 수 있다
  callTimeoutMs: number;
  resyncMs: number; // 연결 중에도 이 간격이 지나면 호출 전에 tools/list 를 다시 본다
  probeTimeoutMs: number;
  negotiation: "auto" | "legacy";
  clientVersion: string;
}

export const DEFAULT_MCP_OPTIONS: McpOptions = {
  idleMs: 10 * 60_000,
  connectTimeoutMs: 90_000,
  callTimeoutMs: 60_000,
  resyncMs: 60_000,
  probeTimeoutMs: 5_000,
  negotiation: "auto",
  clientVersion: "0.1.0",
};

const LOG_LINES = 200;

interface Conn {
  client: Client;
  pid: number | null;
  inFlight: number;
  idle?: ReturnType<typeof setTimeout>;
  syncedAt: number;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Windows: 자식(npx → node 등)까지 함께 끝낸다
function killTree(pid: number | null) {
  if (!pid) return;
  try {
    if (process.platform === "win32")
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {
    // 이미 끝남
  }
}

export class McpManager {
  private conns = new Map<string, Conn>();
  private opening = new Map<string, Promise<Conn>>();
  private state = new Map<string, { status: McpServerInfo["status"]; error: string }>();
  private logs = new Map<string, string[]>();

  constructor(
    readonly store: McpStore,
    private readonly emit: () => void = () => {},
    private readonly opt: McpOptions = DEFAULT_MCP_OPTIONS,
  ) {}

  // ---- 조회 ----

  private setState(id: string, status: McpServerInfo["status"], error = "") {
    this.state.set(id, { status, error });
    this.emit();
  }

  private log(id: string, text: string) {
    const lines = this.logs.get(id) ?? [];
    for (const l of text.split(/\r?\n/)) if (l.trim()) lines.push(l.slice(0, 2000));
    this.logs.set(id, lines.slice(-LOG_LINES));
  }

  logTail(id: string): string[] {
    return this.logs.get(id) ?? [];
  }

  private toolInfoOf(t: ToolRow): McpToolInfo {
    const def = JSON.parse(t.definition) as Record<string, unknown>;
    const ann = (def.annotations ?? {}) as { readOnlyHint?: boolean; title?: string };
    return {
      name: t.name,
      exposed: t.exposed,
      title: String(def.title ?? ann.title ?? t.name),
      description: String(def.description ?? ""),
      readOnly: ann.readOnlyHint === true,
      enabled: t.enabled === 1,
      changed: t.changed === 1,
      definition: def,
      pinned: t.pinned ? JSON.parse(t.pinned) : null,
    };
  }

  info(row: ServerRow): McpServerInfo {
    const st = this.state.get(row.id) ?? { status: this.conns.has(row.id) ? "connected" : "idle", error: "" };
    let serverInfo: McpServerInfo["serverInfo"] = null;
    try {
      serverInfo = row.server_info ? JSON.parse(row.server_info) : null;
    } catch {}
    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      command: row.command,
      args: this.store.args(row),
      url: row.url,
      envKeys: this.store.envKeys(row),
      headerKeys: this.store.headerKeys(row),
      trust: row.trust,
      enabled: row.enabled === 1,
      protocolVersion: row.protocol_version,
      serverInfo,
      status: st.status,
      error: st.error,
      tools: this.store.tools(row.id).map((t) => this.toolInfoOf(t)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): McpServerInfo[] {
    return this.store.list().map((r) => this.info(r));
  }

  isMcp(name: string): boolean {
    return name.startsWith(MCP_PREFIX) && this.store.byExposed(name) !== null;
  }

  serverOf(name: string): string | null {
    return this.store.byExposed(name)?.server.id ?? null;
  }

  /**
   * 승인 판단에 쓰는 도구 정보. ask: 모든 호출 확인(write) · readonly-auto: 고정한 정의가 readOnlyHint 인 도구만 read
   * (readOnlyHint 는 서버의 주장 — 사용자가 서버를 믿을 때만 고르는 정책)
   */
  toolInfo(name: string): ToolInfo | undefined {
    const hit = this.store.byExposed(name);
    if (!hit) return undefined;
    const pinned = (hit.tool.pinned ? JSON.parse(hit.tool.pinned) : {}) as {
      title?: string;
      description?: string;
      annotations?: { readOnlyHint?: boolean };
    };
    const readOnly = hit.server.trust === "readonly-auto" && pinned.annotations?.readOnlyHint === true;
    return {
      name,
      title: `${hit.server.name} · ${pinned.title ?? hit.tool.name}`,
      description: pinned.description ?? "",
      kind: readOnly ? "read" : "write",
    };
  }

  /** 모델에 줄 도구 (켠 서버의 켜고 바뀌지 않은 도구, 고정한 정의로). 연결하지 않고 저장된 것으로 만든다 */
  specs(serverIds: string[]): FunctionTool[] {
    const out: FunctionTool[] = [];
    for (const id of serverIds) {
      const s = this.store.get(id);
      if (s?.enabled !== 1) continue;
      for (const t of this.store.tools(id)) {
        if (!this.store.usable(t)) continue;
        const pinned = JSON.parse(t.pinned) as { description?: string; inputSchema?: unknown };
        out.push({
          type: "function",
          name: t.exposed,
          description: `[MCP server "${s.name}"] ${pinned.description ?? ""}`.slice(0, 1024),
          parameters: normalizeSchema(pinned.inputSchema),
          strict: false,
        });
      }
    }
    return out;
  }

  // ---- 연결 ----

  private async open(row: ServerRow): Promise<Conn> {
    this.setState(row.id, "connecting");
    const make = (mode: "auto" | "legacy") =>
      new Client(
        { name: "proprix", version: this.opt.clientVersion },
        {
          capabilities: {},
          versionNegotiation: { mode, probe: { timeoutMs: this.opt.probeTimeoutMs } },
          inputRequired: { autoFulfill: false },
          listChanged: {
            tools: {
              onChanged: (err, tools) => {
                if (!err && tools) {
                  this.store.sync(row.id, tools as Tool[]);
                  const c = this.conns.get(row.id);
                  if (c) c.syncedAt = Date.now();
                }
              },
            },
          },
        },
      );
    let client = make(this.opt.negotiation);
    let pid: number | null = null;
    try {
      if (row.transport === "stdio") {
        const transport = new StdioClientTransport({
          command: row.command,
          args: this.store.args(row),
          env: { ...scrubEnv(), ...this.store.env(row) },
          stderr: "pipe",
          cwd: homedir(),
        });
        transport.stderr?.on("data", (d: Buffer) => this.log(row.id, d.toString("utf8")));
        try {
          await client.connect(transport, { timeout: this.opt.connectTimeoutMs });
        } finally {
          pid = transport.pid;
        }
      } else {
        const bad = mcpUrlError(row.url);
        if (bad) throw new Error(bad);
        const url = new URL(row.url);
        const headers = this.store.headers(row);
        try {
          await client.connect(
            new StreamableHTTPClientTransport(url, { requestInit: { headers }, redirectPolicy: "same-origin" }),
            { timeout: this.opt.connectTimeoutMs },
          );
        } catch (e) {
          // Streamable HTTP 를 모르는 옛 서버 (404·405) → SSE 로 한 번 더. SDK 는 상태를 status 필드로 알린다
          const status = (e as { status?: unknown }).status;
          if (status !== 404 && status !== 405 && !/\b(404|405)\b/.test(errText(e))) throw e;
          this.log(row.id, `Streamable HTTP 실패 (HTTP ${String(status ?? "?")}) → SSE 로 다시 시도`);
          await client.close().catch(() => {});
          client = make("legacy");
          await client.connect(new SSEClientTransport(url, { requestInit: { headers } }), {
            timeout: this.opt.connectTimeoutMs,
          });
        }
      }
    } catch (e) {
      killTree(pid);
      await client.close().catch(() => {});
      this.log(row.id, `연결 실패: ${errText(e)}`);
      this.setState(row.id, "error", errText(e));
      throw e;
    }
    const conn: Conn = { client, pid, inFlight: 0, syncedAt: 0 };
    client.onclose = () => {
      if (this.conns.get(row.id) === conn) {
        this.conns.delete(row.id);
        clearTimeout(conn.idle);
        killTree(conn.pid);
        if (this.state.get(row.id)?.status === "connected") this.setState(row.id, "idle");
      }
    };
    this.conns.set(row.id, conn);
    // 2026 판은 서버 정보가 discover 결과에 온다
    const v = (client.getServerVersion() ?? client.getDiscoverResult()?.serverInfo) as
      | { name?: string; version?: string }
      | undefined;
    this.store.setNegotiated(
      row.id,
      client.getNegotiatedProtocolVersion() ?? "",
      v?.name ? { name: v.name, version: v.version ?? "" } : null,
    );
    await this.resync(row.id, conn);
    this.setState(row.id, "connected");
    this.scheduleIdle(row.id, conn);
    return conn;
  }

  private async resync(id: string, conn: Conn) {
    const { tools } = await conn.client.listTools();
    this.store.sync(id, tools as Tool[]);
    conn.syncedAt = Date.now();
  }

  /** 연결 (이미 있으면 그대로). 같은 서버에 동시에 여러 번 연결하지 않는다 */
  private async ensure(id: string): Promise<Conn> {
    const live = this.conns.get(id);
    if (live) return live;
    const pending = this.opening.get(id);
    if (pending) return pending;
    const row = this.store.get(id);
    if (!row) throw new Error("없는 서버");
    if (row.enabled !== 1) throw new Error("꺼진 서버입니다");
    const p = this.open(row).finally(() => this.opening.delete(id));
    this.opening.set(id, p);
    return p;
  }

  private scheduleIdle(id: string, conn: Conn) {
    clearTimeout(conn.idle);
    if (conn.inFlight > 0) return;
    conn.idle = setTimeout(() => {
      if (conn.inFlight === 0 && this.conns.get(id) === conn) void this.disconnect(id);
    }, this.opt.idleMs);
  }

  /** 다시 연결해 도구 목록을 새로 받는다 (등록·수정·'새로 고침') */
  async refresh(id: string): Promise<void> {
    await this.disconnect(id);
    const conn = await this.ensure(id);
    this.scheduleIdle(id, conn);
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.conns.get(id);
    this.conns.delete(id);
    if (conn) {
      clearTimeout(conn.idle);
      killTree(conn.pid);
      await conn.client.close().catch(() => {});
    }
    if (this.state.has(id)) this.setState(id, "idle");
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)));
  }

  // ---- 호출 ----

  async call(exposed: string, rawArgs: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
    const fail = (error: string) => ({ ok: false, output: JSON.stringify({ error }) });
    const hit = this.store.byExposed(exposed);
    if (!hit) return fail(`unknown tool: ${exposed}`);
    if (!this.store.usable(hit.tool)) return fail("this tool is turned off or its definition changed");
    let args: unknown;
    try {
      args = JSON.parse(rawArgs || "{}");
    } catch {
      return fail("arguments are not valid JSON");
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) return fail("arguments must be a JSON object");

    let conn: Conn;
    try {
      conn = await this.ensure(hit.server.id);
      if (Date.now() - conn.syncedAt > this.opt.resyncMs) await this.resync(hit.server.id, conn);
    } catch (e) {
      return fail(`could not connect to the MCP server: ${errText(e)}`);
    }
    // 연결하며 다시 받은 정의가 고정한 것과 다르면 (끄고) 실행하지 않는다
    const now = this.store.tool(hit.server.id, hit.tool.name);
    if (!now || !this.store.usable(now))
      return fail("the tool definition changed on the server; it was turned off until the user reviews it");

    conn.inFlight++;
    clearTimeout(conn.idle);
    try {
      const r = await conn.client.callTool(
        { name: hit.tool.name, arguments: args as Record<string, unknown> },
        { timeout: this.opt.callTimeoutMs, signal },
      );
      return formatResult(r as { content?: unknown; structuredContent?: unknown; isError?: boolean });
    } catch (e) {
      const msg = errText(e);
      if (/input.?required|elicitation|sampling/i.test(msg))
        return fail("the server asked for user input that this app does not support (elicitation/sampling)");
      return fail(signal?.aborted ? "cancelled" : msg);
    } finally {
      conn.inFlight--;
      this.scheduleIdle(hit.server.id, conn);
    }
  }
}
