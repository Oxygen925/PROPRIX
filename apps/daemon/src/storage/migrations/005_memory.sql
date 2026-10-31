-- 장기 메모리. seq 는 FTS5 외부 콘텐츠 테이블의 rowid (VACUUM 에도 바뀌지 않게 INTEGER PRIMARY KEY)
CREATE TABLE memories (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  scope          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'event', 'relationship')),
  content        TEXT NOT NULL,
  content_en     TEXT NOT NULL DEFAULT '',
  importance     INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  valid_until    INTEGER,
  superseded_by  TEXT,
  source_room_id TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_used_at   INTEGER
);
CREATE INDEX memories_scope_active ON memories (scope, superseded_by);

-- 검색: unicode61(토큰·접두) 와 trigram(부분 문자열 3자 이상) 두 색인
CREATE VIRTUAL TABLE memories_fts USING fts5(content, content_en, content='memories', content_rowid='seq', tokenize='unicode61');
CREATE VIRTUAL TABLE memories_tri USING fts5(content, content_en, content='memories', content_rowid='seq', tokenize='trigram');

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, content, content_en) VALUES (new.seq, new.content, new.content_en);
  INSERT INTO memories_tri (rowid, content, content_en) VALUES (new.seq, new.content, new.content_en);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, content, content_en) VALUES ('delete', old.seq, old.content, old.content_en);
  INSERT INTO memories_tri (memories_tri, rowid, content, content_en) VALUES ('delete', old.seq, old.content, old.content_en);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF content, content_en ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, content, content_en) VALUES ('delete', old.seq, old.content, old.content_en);
  INSERT INTO memories_tri (memories_tri, rowid, content, content_en) VALUES ('delete', old.seq, old.content, old.content_en);
  INSERT INTO memories_fts (rowid, content, content_en) VALUES (new.seq, new.content, new.content_en);
  INSERT INTO memories_tri (rowid, content, content_en) VALUES (new.seq, new.content, new.content_en);
END;

-- 방마다 어디까지 추출했는지 (이 시각까지의 메시지는 처리됨)
CREATE TABLE memory_watermarks (
  room_id         TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  extracted_until INTEGER NOT NULL
);

ALTER TABLE agents ADD COLUMN memory_isolated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN memory_ids TEXT NOT NULL DEFAULT '[]';

-- 기존 에이전트에도 메모리 도구를 켠다 (새 에이전트의 기본 도구와 같게)
UPDATE agents SET tools = json_insert(tools, '$[#]', 'memory_search', '$[#]', 'memory_save', '$[#]', 'memory_forget')
WHERE json_valid(tools);
