// 사용자 정의 / 명령. 이름은 내장 명령과 겹칠 수 없고, skill(P7c)과 한 이름 공간을 쓴다
import type { Database } from "bun:sqlite";
import { type Command, type CommandInput, commandKey, commandNameError } from "@proprix/shared";
import { isUnique } from "../storage/rows";

interface CommandRow {
  id: string;
  name: string;
  name_key: string;
  description: string;
  template: string;
  created_at: number;
  updated_at: number;
}

const toCommand = (r: CommandRow): Command => ({
  id: r.id,
  name: r.name,
  description: r.description,
  template: r.template,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type CommandError = { error: "invalid" | "taken" | "not_found"; message: string };

export class CommandStore {
  // 이름 공간의 다른 주인 (P7c skill). key 가 이미 쓰이면 true
  otherOwners: ((key: string) => boolean)[] = [];

  constructor(
    private readonly db: Database,
    private readonly onChange: () => void = () => {},
  ) {}

  list(): Command[] {
    return this.db.query<CommandRow, []>("SELECT * FROM commands ORDER BY name_key").all().map(toCommand);
  }

  get(id: string): Command | null {
    const r = this.db.query<CommandRow, { id: string }>("SELECT * FROM commands WHERE id = $id").get({ id });
    return r ? toCommand(r) : null;
  }

  /** 이 이름을 다른 명령(exceptId 제외)이나 skill 이 쓰고 있나 */
  nameTaken(key: string, exceptId = ""): boolean {
    const row = this.db
      .query<{ id: string }, { key: string }>("SELECT id FROM commands WHERE name_key = $key")
      .get({ key });
    if (row && row.id !== exceptId) return true;
    return this.otherOwners.some((taken) => taken(key));
  }

  private check(name: string, exceptId = ""): CommandError | null {
    const e = commandNameError(name);
    if (e) return { error: "invalid", message: e };
    if (this.nameTaken(commandKey(name), exceptId))
      return { error: "taken", message: `/${name} 은(는) 이미 있는 명령어나 Skill 이름입니다. 다른 이름을 고르세요` };
    return null;
  }

  create(input: CommandInput): Command | CommandError {
    const err = this.check(input.name);
    if (err) return err;
    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      this.db
        .query(
          `INSERT INTO commands (id, name, name_key, description, template, created_at, updated_at)
           VALUES ($id, $name, $key, $description, $template, $now, $now)`,
        )
        .run({
          id,
          name: input.name,
          key: commandKey(input.name),
          description: input.description,
          template: input.template,
          now,
        });
    } catch (e) {
      if (isUnique(e)) return { error: "taken", message: `/${input.name} 은(는) 이미 있는 이름입니다` };
      throw e;
    }
    this.onChange();
    return this.get(id) as Command;
  }

  update(id: string, input: CommandInput): Command | CommandError {
    if (!this.get(id)) return { error: "not_found", message: "없는 명령어입니다" };
    const err = this.check(input.name, id);
    if (err) return err;
    try {
      this.db
        .query(
          `UPDATE commands SET name = $name, name_key = $key, description = $description, template = $template,
           updated_at = $now WHERE id = $id`,
        )
        .run({
          id,
          name: input.name,
          key: commandKey(input.name),
          description: input.description,
          template: input.template,
          now: Date.now(),
        });
    } catch (e) {
      if (isUnique(e)) return { error: "taken", message: `/${input.name} 은(는) 이미 있는 이름입니다` };
      throw e;
    }
    this.onChange();
    return this.get(id) as Command;
  }

  delete(id: string): boolean {
    const changes = this.db.query("DELETE FROM commands WHERE id = $id").run({ id }).changes;
    if (changes) this.onChange();
    return changes > 0;
  }
}
