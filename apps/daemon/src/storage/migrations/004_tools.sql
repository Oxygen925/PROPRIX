-- 에이전트 도구 설정 (JSON 배열 = 허용 도구 이름)
ALTER TABLE agents ADD COLUMN tools TEXT NOT NULL DEFAULT '["current_time","note_search","note_create","note_update","note_delete"]';
ALTER TABLE agents ADD COLUMN auto_approve_writes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN web_search INTEGER NOT NULL DEFAULT 0;

-- 웹 검색 출처 (JSON 배열 [{url, title}])
ALTER TABLE messages ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';

CREATE TABLE tool_calls (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  args       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('read', 'write')),
  status     TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'denied')),
  output     TEXT NOT NULL DEFAULT '',
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX tool_calls_room_created ON tool_calls (room_id, created_at);

CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  agent_id   TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX notes_updated ON notes (updated_at);
