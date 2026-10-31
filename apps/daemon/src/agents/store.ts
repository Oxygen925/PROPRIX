// 페르소나(성격·말투)와 에이전트(페르소나 + 역할 + 모델) 저장.
import type { Database } from "bun:sqlite";
import {
  type Agent,
  AgentEffort,
  type AgentInput,
  Checkin,
  DEFAULT_CHECKIN,
  type Persona,
  type PersonaInput,
} from "@proprix/shared";
import { parseIds } from "../storage/rows";

export const DEFAULT_PERSONA_ID = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_AGENT_ID = "00000000-0000-4000-8000-000000000002";

interface PersonaRow {
  id: string;
  name: string;
  emoji: string;
  color: string;
  description: string;
  body: string;
  pet_character_id: string;
  avatar_image: string;
  builtin: number;
  created_at: number;
  updated_at: number;
}

const toPersona = (r: PersonaRow, character: string | null): Persona => ({
  id: r.id,
  character,
  name: r.name,
  emoji: r.emoji,
  color: r.color,
  description: r.description,
  body: r.body,
  petCharacterId: r.pet_character_id,
  avatarImage: r.avatar_image,
  builtin: r.builtin === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface AgentRow {
  id: string;
  persona_id: string;
  name: string;
  role: string;
  model: string;
  tools: string;
  auto_approve_writes: number;
  web_search: number;
  memory_isolated: number;
  checkin: string;
  auto_approve_tools: string;
  reasoning_effort: string;
  skills: string;
  mcp_servers: string;
  builtin: number;
  created_at: number;
  updated_at: number;
}

function parseCheckin(raw: string): Checkin {
  try {
    const p = Checkin.safeParse(JSON.parse(raw));
    return p.success ? p.data : DEFAULT_CHECKIN;
  } catch {
    return DEFAULT_CHECKIN;
  }
}

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  personaId: r.persona_id,
  name: r.name,
  role: r.role,
  model: r.model,
  tools: parseIds(r.tools),
  autoApproveWrites: r.auto_approve_writes === 1,
  webSearch: r.web_search === 1,
  memoryIsolated: r.memory_isolated === 1,
  checkin: parseCheckin(r.checkin),
  autoApproveTools: parseIds(r.auto_approve_tools),
  reasoningEffort: AgentEffort.safeParse(r.reasoning_effort).data ?? "",
  skills: parseIds(r.skills),
  mcpServers: parseIds(r.mcp_servers),
  builtin: r.builtin === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// not_found | in_use: 참조하는 에이전트·방이 있음 | builtin: 기본 항목은 삭제 불가
export type DeleteError = "not_found" | "in_use" | "builtin";

export class AgentStore {
  // 표정 묶음의 버전 (파일에 있어 app 이 이어 준다)
  characterVersion: (personaId: string) => string | null = () => null;

  constructor(private readonly db: Database) {}

  // ---- 페르소나 ----

  personas(): Persona[] {
    return this.db
      .query<PersonaRow, []>("SELECT * FROM personas ORDER BY builtin DESC, created_at")
      .all()
      .map((r) => toPersona(r, this.characterVersion(r.id)));
  }

  persona(id: string): Persona | null {
    const r = this.db.query<PersonaRow, { id: string }>("SELECT * FROM personas WHERE id = $id").get({ id });
    return r ? toPersona(r, this.characterVersion(r.id)) : null;
  }

  createPersona(p: PersonaInput): Persona {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO personas (id, name, emoji, color, description, body, pet_character_id, avatar_image, created_at,
         updated_at) VALUES ($id, $name, $emoji, $color, $description, $body, $pet, $avatar, $now, $now)`,
      )
      .run({ id, ...personaParams(p), now });
    return this.persona(id) as Persona;
  }

  updatePersona(id: string, p: PersonaInput): Persona | null {
    const changes = this.db
      .query(
        `UPDATE personas SET name = $name, emoji = $emoji, color = $color, description = $description, body = $body,
         pet_character_id = $pet, avatar_image = $avatar, updated_at = $now WHERE id = $id`,
      )
      .run({ id, ...personaParams(p), now: Date.now() }).changes;
    return changes ? this.persona(id) : null;
  }

  deletePersona(id: string): DeleteError | null {
    const p = this.persona(id);
    if (!p) return "not_found";
    if (p.builtin) return "builtin";
    if (this.db.query("SELECT 1 FROM agents WHERE persona_id = $id").get({ id })) return "in_use";
    this.db.query("DELETE FROM personas WHERE id = $id").run({ id });
    return null;
  }

  // ---- 에이전트 ----

  agents(): Agent[] {
    return this.db.query<AgentRow, []>("SELECT * FROM agents ORDER BY builtin DESC, created_at").all().map(toAgent);
  }

  agent(id: string): Agent | null {
    const r = this.db.query<AgentRow, { id: string }>("SELECT * FROM agents WHERE id = $id").get({ id });
    return r ? toAgent(r) : null;
  }

  // 페르소나가 없으면 null
  createAgent(a: AgentInput): Agent | null {
    if (!this.persona(a.personaId)) return null;
    const now = Date.now();
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO agents (id, persona_id, name, role, model, tools, auto_approve_writes, web_search, memory_isolated,
         checkin, reasoning_effort, skills, mcp_servers, created_at, updated_at)
         VALUES ($id, $persona, $name, $role, $model, $tools, $auto, $web, $isolated, $checkin, $effort, $skills, $mcp, $now, $now)`,
      )
      .run({ id, ...agentParams(a), now });
    return this.agent(id);
  }

  updateAgent(id: string, a: AgentInput): Agent | "not_found" | "no_persona" {
    if (!this.persona(a.personaId)) return "no_persona";
    const changes = this.db
      .query(
        `UPDATE agents SET persona_id = $persona, name = $name, role = $role, model = $model, tools = $tools,
         auto_approve_writes = $auto, web_search = $web, memory_isolated = $isolated, checkin = $checkin,
         reasoning_effort = $effort, skills = $skills, mcp_servers = $mcp, updated_at = $now WHERE id = $id`,
      )
      .run({ id, ...agentParams(a), now: Date.now() }).changes;
    return changes ? (this.agent(id) as Agent) : "not_found";
  }

  // 체크인을 처리한 마지막 날짜 (로컬 YYYY-MM-DD). 편집기 저장(updateAgent)과 따로 둔다
  checkinLast(id: string): string {
    return (
      this.db.query<{ v: string }, { id: string }>("SELECT checkin_last AS v FROM agents WHERE id = $id").get({ id })
        ?.v ?? ""
    );
  }

  setCheckinLast(id: string, date: string) {
    this.db.query("UPDATE agents SET checkin_last = $date WHERE id = $id").run({ id, date });
  }

  // 승인 카드의 '항상 허용' 규칙 (이 에이전트의 이 도구). updateAgent 와 따로 둬 편집기 저장으로 지워지지 않게 한다
  allowTool(id: string, tool: string): Agent | null {
    const a = this.agent(id);
    if (!a) return null;
    if (!a.autoApproveTools.includes(tool)) this.setAutoApproveTools(id, [...a.autoApproveTools, tool]);
    return this.agent(id);
  }

  revokeTool(id: string, tool: string): Agent | null {
    const a = this.agent(id);
    if (!a) return null;
    this.setAutoApproveTools(
      id,
      a.autoApproveTools.filter((t) => t !== tool),
    );
    return this.agent(id);
  }

  private setAutoApproveTools(id: string, tools: string[]) {
    this.db
      .query("UPDATE agents SET auto_approve_tools = $tools, updated_at = $now WHERE id = $id")
      .run({ id, tools: JSON.stringify(tools), now: Date.now() });
  }

  // 지운 skill 을 모든 에이전트 목록에서 뺀다 (key: 비교용 이름)
  removeSkill(key: string, keyOf: (name: string) => string) {
    for (const a of this.agents()) {
      const left = a.skills.filter((n) => keyOf(n) !== key);
      if (left.length !== a.skills.length)
        this.db
          .query("UPDATE agents SET skills = $skills, updated_at = $now WHERE id = $id")
          .run({ id: a.id, skills: JSON.stringify(left), now: Date.now() });
    }
  }

  // 지운 MCP 서버의 '항상 허용' 규칙을 모든 에이전트에서 지운다 (같은 이름으로 다시 만든 다른 서버가 물려받지 않게)
  revokeToolPrefix(prefix: string) {
    const p = prefix.toLowerCase();
    for (const a of this.agents()) {
      const left = a.autoApproveTools.filter((t) => !t.toLowerCase().startsWith(p));
      if (left.length !== a.autoApproveTools.length) this.setAutoApproveTools(a.id, left);
    }
  }

  // 지운 MCP 서버를 모든 에이전트 목록에서 뺀다
  removeMcpServer(serverId: string) {
    for (const a of this.agents())
      if (a.mcpServers.includes(serverId))
        this.db
          .query("UPDATE agents SET mcp_servers = $list, updated_at = $now WHERE id = $id")
          .run({ id: a.id, list: JSON.stringify(a.mcpServers.filter((s) => s !== serverId)), now: Date.now() });
  }

  deleteAgent(id: string): DeleteError | null {
    const a = this.agent(id);
    if (!a) return "not_found";
    if (a.builtin) return "builtin";
    if (this.db.query("SELECT 1 FROM room_members WHERE agent_id = $id").get({ id })) return "in_use";
    this.db.query("DELETE FROM agents WHERE id = $id").run({ id });
    return null;
  }
}

function agentParams(a: AgentInput) {
  return {
    persona: a.personaId,
    name: a.name,
    role: a.role,
    model: a.model,
    tools: JSON.stringify([...new Set(a.tools)]),
    auto: a.autoApproveWrites ? 1 : 0,
    web: a.webSearch ? 1 : 0,
    isolated: a.memoryIsolated ? 1 : 0,
    checkin: JSON.stringify(a.checkin),
    effort: a.reasoningEffort,
    skills: JSON.stringify([...new Set(a.skills)]),
    mcp: JSON.stringify([...new Set(a.mcpServers)]),
  };
}

function personaParams(p: PersonaInput) {
  return {
    name: p.name,
    emoji: p.emoji,
    color: p.color,
    description: p.description,
    body: p.body,
    pet: p.petCharacterId,
    avatar: p.avatarImage,
  };
}
