// 에이전트 팀 프리셋 (P10d): 기존 에이전트 묶음(참가자·순서·연쇄 상한). 역할·도구는 각 에이전트 설정을 그대로 쓴다
import type { Database } from "bun:sqlite";
import { type Team, type TeamInput, teamKey } from "@proprix/shared";
import { isUnique, parseIds } from "../storage/rows";

interface TeamRow {
  id: string;
  name: string;
  name_key: string;
  description: string;
  agent_ids: string;
  chain_limit: number;
  created_at: number;
  updated_at: number;
}

const toTeam = (r: TeamRow): Team => ({
  id: r.id,
  name: r.name,
  description: r.description,
  agentIds: parseIds(r.agent_ids),
  chainLimit: r.chain_limit,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type TeamError = { error: "invalid" | "taken" | "not_found"; message: string };

export class TeamStore {
  constructor(
    private readonly db: Database,
    private readonly agentExists: (id: string) => boolean,
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  list(): Team[] {
    return this.db.query<TeamRow, []>("SELECT * FROM teams ORDER BY name_key").all().map(toTeam);
  }

  get(id: string): Team | null {
    const r = this.db.query<TeamRow, { id: string }>("SELECT * FROM teams WHERE id = $id").get({ id });
    return r ? toTeam(r) : null;
  }

  // /team 이름: 대소문자·앞뒤 공백을 무시하고 찾는다
  byName(name: string): Team | null {
    const r = this.db
      .query<TeamRow, { key: string }>("SELECT * FROM teams WHERE name_key = $key")
      .get({ key: teamKey(name) });
    return r ? toTeam(r) : null;
  }

  create(input: TeamInput): Team | TeamError {
    const bad = this.check(input);
    if (bad) return bad;
    const id = crypto.randomUUID();
    const now = this.now();
    try {
      this.db
        .query(
          `INSERT INTO teams (id, name, name_key, description, agent_ids, chain_limit, created_at, updated_at)
           VALUES ($id, $name, $key, $description, $agents, $chain, $now, $now)`,
        )
        .run({ id, ...params(input), now });
    } catch (e) {
      if (isUnique(e)) return taken(input.name);
      throw e;
    }
    this.onChange();
    return this.get(id) as Team;
  }

  update(id: string, input: TeamInput): Team | TeamError {
    if (!this.get(id)) return { error: "not_found", message: "없는 팀" };
    const bad = this.check(input);
    if (bad) return bad;
    try {
      this.db
        .query(
          `UPDATE teams SET name = $name, name_key = $key, description = $description, agent_ids = $agents,
           chain_limit = $chain, updated_at = $now WHERE id = $id`,
        )
        .run({ id, ...params(input), now: this.now() });
    } catch (e) {
      if (isUnique(e)) return taken(input.name);
      throw e;
    }
    this.onChange();
    return this.get(id) as Team;
  }

  delete(id: string): boolean {
    const changes = this.db.query("DELETE FROM teams WHERE id = $id").run({ id }).changes;
    if (changes) this.onChange();
    return changes > 0;
  }

  // 지운 에이전트를 모든 팀에서 뺀다 (2명 미만이 된 팀도 남겨 둔다 — 화면에 '참가자 부족')
  removeAgent(agentId: string) {
    let changed = false;
    for (const t of this.list()) {
      if (!t.agentIds.includes(agentId)) continue;
      this.db
        .query("UPDATE teams SET agent_ids = $agents, updated_at = $now WHERE id = $id")
        .run({ id: t.id, agents: JSON.stringify(t.agentIds.filter((a) => a !== agentId)), now: this.now() });
      changed = true;
    }
    if (changed) this.onChange();
  }

  private check(input: TeamInput): TeamError | null {
    const missing = input.agentIds.filter((id) => !this.agentExists(id));
    return missing.length ? { error: "invalid", message: "없는 에이전트가 들어 있습니다" } : null;
  }
}

const params = (t: TeamInput) => ({
  name: t.name,
  key: teamKey(t.name),
  description: t.description,
  agents: JSON.stringify(t.agentIds),
  chain: t.chainLimit,
});

const taken = (name: string): TeamError => ({
  error: "taken",
  message: `'${name}' 팀이 이미 있습니다. 다른 이름을 고르세요`,
});
