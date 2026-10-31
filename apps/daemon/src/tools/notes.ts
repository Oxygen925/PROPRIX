// 로컬 메모: 도구와 /notes 화면이 같이 쓴다
import type { Database } from "bun:sqlite";
import type { Note, NoteInput } from "@proprix/shared";

interface NoteRow {
  id: string;
  title: string;
  body: string;
  agent_id: string;
  created_at: number;
  updated_at: number;
}

const toNote = (r: NoteRow): Note => ({
  id: r.id,
  title: r.title,
  body: r.body,
  agentId: r.agent_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// LIKE 와일드카드를 글자 그대로 찾게 한다
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class NoteStore {
  constructor(
    private readonly db: Database,
    private readonly onChange: () => void = () => {},
  ) {}

  list(query = "", limit = 100): Note[] {
    const q = query.trim();
    if (!q)
      return this.db
        .query<NoteRow, { limit: number }>("SELECT * FROM notes ORDER BY updated_at DESC LIMIT $limit")
        .all({ limit })
        .map(toNote);
    return this.db
      .query<NoteRow, { q: string; limit: number }>(
        `SELECT * FROM notes WHERE title LIKE $q ESCAPE '\\' OR body LIKE $q ESCAPE '\\'
         ORDER BY updated_at DESC LIMIT $limit`,
      )
      .all({ q: `%${likeEscape(q)}%`, limit })
      .map(toNote);
  }

  get(id: string): Note | null {
    const r = this.db.query<NoteRow, { id: string }>("SELECT * FROM notes WHERE id = $id").get({ id });
    return r ? toNote(r) : null;
  }

  create(input: NoteInput, agentId = ""): Note {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO notes (id, title, body, agent_id, created_at, updated_at)
         VALUES ($id, $title, $body, $agent, $now, $now)`,
      )
      .run({ id, title: input.title, body: input.body, agent: agentId, now });
    this.onChange();
    return this.get(id) as Note;
  }

  update(id: string, patch: Partial<NoteInput>): Note | null {
    const cur = this.get(id);
    if (!cur) return null;
    this.db
      .query("UPDATE notes SET title = $title, body = $body, updated_at = $now WHERE id = $id")
      .run({ id, title: patch.title ?? cur.title, body: patch.body ?? cur.body, now: Date.now() });
    this.onChange();
    return this.get(id);
  }

  delete(id: string): boolean {
    const changes = this.db.query("DELETE FROM notes WHERE id = $id").run({ id }).changes;
    if (changes) this.onChange();
    return changes > 0;
  }
}
