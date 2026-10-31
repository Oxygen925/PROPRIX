import { Database } from "bun:sqlite";
import init001 from "./migrations/001_init.sql" with { type: "text" };
import chat002 from "./migrations/002_chat.sql" with { type: "text" };
import agents003 from "./migrations/003_agents.sql" with { type: "text" };
import tools004 from "./migrations/004_tools.sql" with { type: "text" };
import memory005 from "./migrations/005_memory.sql" with { type: "text" };
import backlog006 from "./migrations/006_memory_backlog.sql" with { type: "text" };
import multi007 from "./migrations/007_multi_agent.sql" with { type: "text" };
import debates008 from "./migrations/008_debates.sql" with { type: "text" };
import lounge009 from "./migrations/009_lounge.sql" with { type: "text" };
import embeddings010 from "./migrations/010_memory_embeddings.sql" with { type: "text" };
import proactive011 from "./migrations/011_proactive.sql" with { type: "text" };
import ui012 from "./migrations/012_ui.sql" with { type: "text" };
import effort013 from "./migrations/013_effort.sql" with { type: "text" };
import roomsAttachments014 from "./migrations/014_rooms_attachments.sql" with { type: "text" };
import workspace015 from "./migrations/015_workspace.sql" with { type: "text" };
import commands016 from "./migrations/016_commands.sql" with { type: "text" };
import skills017 from "./migrations/017_skills.sql" with { type: "text" };
import mcp018 from "./migrations/018_mcp.sql" with { type: "text" };
import tasks019 from "./migrations/019_tasks.sql" with { type: "text" };
import subchat020 from "./migrations/020_subchat.sql" with { type: "text" };
import audit021 from "./migrations/021_tool_audit.sql" with { type: "text" };
import teams022 from "./migrations/022_teams.sql" with { type: "text" };
import memorySource023 from "./migrations/023_memory_source.sql" with { type: "text" };
import research024 from "./migrations/024_research.sql" with { type: "text" };
import researchAgents025 from "./migrations/025_research_agents.sql" with { type: "text" };
import siteAccounts026 from "./migrations/026_site_accounts.sql" with { type: "text" };
import researchMessages027 from "./migrations/027_research_messages.sql" with { type: "text" };

interface Migration {
  id: number;
  name: string;
  sql: string;
}

// 순서대로만 추가한다. 이미 배포된 항목은 수정하지 않는다
export const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: "init", sql: init001 },
  { id: 2, name: "chat", sql: chat002 },
  { id: 3, name: "agents", sql: agents003 },
  { id: 4, name: "tools", sql: tools004 },
  { id: 5, name: "memory", sql: memory005 },
  { id: 6, name: "memory_backlog", sql: backlog006 },
  { id: 7, name: "multi_agent", sql: multi007 },
  { id: 8, name: "debates", sql: debates008 },
  { id: 9, name: "lounge", sql: lounge009 },
  { id: 10, name: "memory_embeddings", sql: embeddings010 },
  { id: 11, name: "proactive", sql: proactive011 },
  { id: 12, name: "ui", sql: ui012 },
  { id: 13, name: "effort", sql: effort013 },
  { id: 14, name: "rooms_attachments", sql: roomsAttachments014 },
  { id: 15, name: "workspace", sql: workspace015 },
  { id: 16, name: "commands", sql: commands016 },
  { id: 17, name: "skills", sql: skills017 },
  { id: 18, name: "mcp", sql: mcp018 },
  { id: 19, name: "tasks", sql: tasks019 },
  { id: 20, name: "subchat", sql: subchat020 },
  { id: 21, name: "tool_audit", sql: audit021 },
  { id: 22, name: "teams", sql: teams022 },
  { id: 23, name: "memory_source", sql: memorySource023 },
  { id: 24, name: "research", sql: research024 },
  { id: 25, name: "research_agents", sql: researchAgents025 },
  { id: 26, name: "site_accounts", sql: siteAccounts026 },
  { id: 27, name: "research_messages", sql: researchMessages027 },
];

// db.query() 캐시(기본 20개)에서 밀려난 문장은 GC 전까지 정리되지 않아 close(true) 로도 연결이 닫히지 않는다
// (Windows 에서 파일이 잠긴 채 남음). 앱이 쓰는 SQL 종류보다 넉넉하게 잡아 밀려나지 않게 한다
const QUERY_CACHE_SIZE = 256;

export const latestMigration = () => Math.max(...MIGRATIONS.map((m) => m.id));

export function openDb(path: string): Database {
  Database.MAX_QUERY_CACHE_SIZE = Math.max(Database.MAX_QUERY_CACHE_SIZE, QUERY_CACHE_SIZE);
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    db
      .query<{ id: number }, []>("SELECT id FROM schema_migrations")
      .all()
      .map((r) => r.id),
  );
  const insert = db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES ($id, $name, $at)");
  const ran: number[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run({ id: m.id, name: m.name, at: Date.now() });
    })();
    ran.push(m.id);
  }
  return ran;
}
