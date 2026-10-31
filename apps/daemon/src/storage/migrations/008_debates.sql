-- P4b 토론·협업: 방 안에서 주제·참가자·라운드·진행자를 정해 진행한다
CREATE TABLE debates (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL CHECK (mode IN ('debate', 'collab')),
  topic        TEXT NOT NULL,
  agent_ids    TEXT NOT NULL, -- JSON 배열, 발언 순서
  moderator_id TEXT NOT NULL,
  rounds       INTEGER NOT NULL,
  round        INTEGER NOT NULL DEFAULT 0, -- 진행 위치 (0 = 여는 말, rounds + 1 = 맺는 말)
  status       TEXT NOT NULL CHECK (status IN ('running', 'done', 'stopped', 'failed')),
  error_code   TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX debates_room_created ON debates (room_id, created_at);

-- 토론 발언 표시 (기억 추출에서 뺀다)
ALTER TABLE messages ADD COLUMN debate_id TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN debate_round INTEGER NOT NULL DEFAULT 0;
