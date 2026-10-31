CREATE TABLE rooms (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('streaming', 'complete', 'partial', 'failed')),
  model      TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  recovery   TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_room_created ON messages (room_id, created_at);

-- LLM 호출 장부: 기능별 사용량·결과 (대화 원문은 넣지 않는다)
CREATE TABLE usage_ledger (
  id          INTEGER PRIMARY KEY,
  feature     TEXT NOT NULL,
  model       TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  code        TEXT NOT NULL,
  attempts    INTEGER NOT NULL,
  chars       INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  started_at  INTEGER NOT NULL
);
CREATE INDEX usage_ledger_feature_started ON usage_ledger (feature, started_at);
