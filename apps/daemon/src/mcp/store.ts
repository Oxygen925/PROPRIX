// MCP 서버·도구 저장. env·헤더 값은 봉해서 두고 (Windows: DPAPI) 밖으로는 키만 낸다.
// 도구는 처음 보면 꺼진 채 기록하고, 켤 때 그 정의를 고정한다. 고정한 정의와 달라지면 끄고 changed 로 표시한다
import type { Database } from "bun:sqlite";
import type { Tool } from "@modelcontextprotocol/client";
import { type McpServerInput, McpServerInput as McpServerInputSchema, type McpTrust } from "@proprix/shared";
import { definitionHash, definitionOf, exposedName } from "./schema";

export interface SecretCodec {
  seal(plain: Uint8Array): Uint8Array;
  open(sealed: Uint8Array): Uint8Array | null;
}
export const plainCodec: SecretCodec = { seal: (b) => b.slice(), open: (b) => b.slice() };
export function defaultCodec(): SecretCodec {
  if (process.platform !== "win32") return plainCodec;
  const { dpapi } = require("../auth/dpapi") as typeof import("../auth/dpapi");
  return dpapi;
}

export interface ServerRow {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  env_enc: string;
  url: string;
  headers_enc: string;
  trust: McpTrust;
  enabled: number;
  protocol_version: string;
  server_info: string;
  created_at: number;
  updated_at: number;
}

export interface ToolRow {
  server_id: string;
  name: string;
  exposed: string;
  enabled: number;
  definition: string;
  pinned: string;
  def_hash: string;
  changed: number;
}

export type McpStoreError = { error: "invalid" | "taken" | "not_found"; message: string };

const parseList = (raw: string): string[] => {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

export class McpStore {
  constructor(
    private readonly db: Database,
    private readonly codec: SecretCodec = defaultCodec(),
    private readonly onChange: () => void = () => {},
  ) {}

  // ---- 비밀 ----

  private seal(map: Record<string, string>): string {
    if (Object.keys(map).length === 0) return "";
    return Buffer.from(this.codec.seal(new TextEncoder().encode(JSON.stringify(map)))).toString("base64");
  }

  private open(enc: string): Record<string, string> {
    if (!enc) return {};
    const plain = this.codec.open(new Uint8Array(Buffer.from(enc, "base64")));
    if (!plain) return {};
    try {
      return JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
    } finally {
      plain.fill(0);
    }
  }

  env(row: ServerRow): Record<string, string> {
    return this.open(row.env_enc);
  }

  headers(row: ServerRow): Record<string, string> {
    return this.open(row.headers_enc);
  }

  envKeys(row: ServerRow): string[] {
    return Object.keys(this.env(row)).sort();
  }

  headerKeys(row: ServerRow): string[] {
    return Object.keys(this.headers(row)).sort();
  }

  // 값이 "" 인 키는 저장된 값을 그대로, 목록에 없는 키는 지운다
  private merge(old: Record<string, string>, next: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === "" ? (old[k] ?? "") : v]));
  }

  // ---- 서버 ----

  list(): ServerRow[] {
    return this.db.query<ServerRow, []>("SELECT * FROM mcp_servers ORDER BY name").all();
  }

  get(id: string): ServerRow | null {
    return this.db.query<ServerRow, { id: string }>("SELECT * FROM mcp_servers WHERE id = $id").get({ id });
  }

  args(row: ServerRow): string[] {
    return parseList(row.args);
  }

  create(raw: McpServerInput): ServerRow | McpStoreError {
    const p = McpServerInputSchema.safeParse(raw);
    if (!p.success) return { error: "invalid", message: p.error.issues[0]?.message ?? "형식 오류" };
    const s = p.data;
    if (this.db.query("SELECT 1 FROM mcp_servers WHERE name = $name").get({ name: s.name }))
      return { error: "taken", message: `이미 있는 서버 이름입니다: ${s.name}` };
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO mcp_servers (id, name, transport, command, args, env_enc, url, headers_enc, trust, enabled,
         created_at, updated_at)
         VALUES ($id, $name, $transport, $command, $args, $env, $url, $headers, $trust, $enabled, $now, $now)`,
      )
      .run({
        id,
        name: s.name,
        transport: s.transport,
        command: s.transport === "stdio" ? s.command : "",
        args: JSON.stringify(s.transport === "stdio" ? s.args : []),
        env: s.transport === "stdio" ? this.seal(s.env) : "",
        url: s.transport === "http" ? s.url : "",
        headers: s.transport === "http" ? this.seal(s.headers) : "",
        trust: s.trust,
        enabled: s.enabled ? 1 : 0,
        now,
      });
    this.onChange();
    return this.get(id) as ServerRow;
  }

  /** 이름은 바꾸지 않는다 (도구 이름·'항상 허용' 규칙이 이름을 쓴다) */
  update(id: string, raw: McpServerInput): ServerRow | McpStoreError {
    const cur = this.get(id);
    if (!cur) return { error: "not_found", message: "없는 서버" };
    const p = McpServerInputSchema.safeParse(raw);
    if (!p.success) return { error: "invalid", message: p.error.issues[0]?.message ?? "형식 오류" };
    const s = p.data;
    if (s.name.toLowerCase() !== cur.name.toLowerCase())
      return { error: "invalid", message: "서버 이름은 바꿀 수 없습니다 (삭제하고 새로 만드세요)" };
    this.db
      .query(
        `UPDATE mcp_servers SET transport = $transport, command = $command, args = $args, env_enc = $env, url = $url,
         headers_enc = $headers, trust = $trust, enabled = $enabled, updated_at = $now WHERE id = $id`,
      )
      .run({
        id,
        transport: s.transport,
        command: s.transport === "stdio" ? s.command : "",
        args: JSON.stringify(s.transport === "stdio" ? s.args : []),
        env: s.transport === "stdio" ? this.seal(this.merge(this.env(cur), s.env)) : "",
        url: s.transport === "http" ? s.url : "",
        headers: s.transport === "http" ? this.seal(this.merge(this.headers(cur), s.headers)) : "",
        trust: s.trust,
        enabled: s.enabled ? 1 : 0,
        now: Date.now(),
      });
    this.onChange();
    return this.get(id) as ServerRow;
  }

  remove(id: string): boolean {
    const n = this.db.query("DELETE FROM mcp_servers WHERE id = $id").run({ id }).changes;
    if (n) this.onChange();
    return n > 0;
  }

  setNegotiated(id: string, version: string, info: { name: string; version: string } | null) {
    this.db
      .query("UPDATE mcp_servers SET protocol_version = $version, server_info = $info WHERE id = $id")
      .run({ id, version, info: info ? JSON.stringify({ name: info.name, version: info.version }) : "" });
  }

  // ---- 도구 ----

  tools(serverId: string): ToolRow[] {
    return this.db
      .query<ToolRow, { id: string }>("SELECT * FROM mcp_tools WHERE server_id = $id ORDER BY name")
      .all({ id: serverId });
  }

  tool(serverId: string, name: string): ToolRow | null {
    return this.db
      .query<ToolRow, { id: string; name: string }>("SELECT * FROM mcp_tools WHERE server_id = $id AND name = $name")
      .get({ id: serverId, name });
  }

  byExposed(exposed: string): { server: ServerRow; tool: ToolRow } | null {
    const tool = this.db
      .query<ToolRow, { e: string }>("SELECT * FROM mcp_tools WHERE exposed = $e")
      .get({ e: exposed });
    const server = tool ? this.get(tool.server_id) : null;
    return tool && server ? { server, tool } : null;
  }

  /**
   * tools/list 결과를 반영한다. 새 도구는 꺼진 채 추가, 사라진 도구는 지움,
   * 켜 둔 도구의 정의가 고정한 것과 다르면 끄고 changed 로 표시한다. 바뀐 것이 있으면 true
   */
  sync(serverId: string, list: Tool[]): boolean {
    const server = this.get(serverId);
    if (!server) return false;
    const old = new Map(this.tools(serverId).map((t) => [t.name, t]));
    let touched = false;
    this.db.transaction(() => {
      for (const t of list) {
        const def = definitionOf(t);
        const json = JSON.stringify(def);
        const prev = old.get(t.name);
        old.delete(t.name);
        if (!prev) {
          const exposed = exposedName(server.name, t.name, (n) =>
            Boolean(this.db.query("SELECT 1 FROM mcp_tools WHERE exposed = $n").get({ n })),
          );
          this.db
            .query(
              `INSERT INTO mcp_tools (server_id, name, exposed, enabled, definition) VALUES ($id, $name, $exposed, 0, $def)`,
            )
            .run({ id: serverId, name: t.name, exposed, def: json });
          touched = true;
          continue;
        }
        const drift = prev.enabled === 1 && definitionHash(def) !== prev.def_hash;
        if (prev.definition !== json || drift) {
          this.db
            .query(
              `UPDATE mcp_tools SET definition = $def, enabled = CASE WHEN $drift THEN 0 ELSE enabled END,
               changed = CASE WHEN $drift THEN 1 ELSE changed END WHERE server_id = $id AND name = $name`,
            )
            .run({ id: serverId, name: t.name, def: json, drift: drift ? 1 : 0 });
          touched = true;
        }
      }
      for (const gone of old.keys()) {
        this.db.query("DELETE FROM mcp_tools WHERE server_id = $id AND name = $name").run({ id: serverId, name: gone });
        touched = true;
      }
    })();
    if (touched) this.onChange();
    return touched;
  }

  /** 켜면 지금 정의를 고정한다 (사용자가 화면에서 본 그 정의) */
  setToolEnabled(serverId: string, name: string, on: boolean): ToolRow | null {
    const t = this.tool(serverId, name);
    if (!t) return null;
    if (on)
      this.db
        .query(
          "UPDATE mcp_tools SET enabled = 1, changed = 0, pinned = definition, def_hash = $hash WHERE server_id = $id AND name = $name",
        )
        .run({ id: serverId, name, hash: definitionHash(JSON.parse(t.definition)) });
    else
      this.db
        .query("UPDATE mcp_tools SET enabled = 0 WHERE server_id = $id AND name = $name")
        .run({ id: serverId, name });
    this.onChange();
    return this.tool(serverId, name);
  }

  /** 이 도구를 지금 써도 되는가: 켜져 있고, 바뀌지 않았고, 지금 정의가 고정한 해시와 같음 */
  usable(t: ToolRow): boolean {
    return (
      t.enabled === 1 && t.changed === 0 && !!t.def_hash && definitionHash(JSON.parse(t.definition)) === t.def_hash
    );
  }
}
