-- P4c 자율 대화(라운지): 사용자 없이 에이전트끼리 나누는 잡담이 쌓이는 방과 세션 기록
ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'lounge'));

CREATE TABLE lounge_sessions (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_ids  TEXT NOT NULL, -- JSON 배열
  turns      INTEGER NOT NULL, -- 계획한 발언 수
  spoken     INTEGER NOT NULL DEFAULT 0,
  manual     INTEGER NOT NULL DEFAULT 0, -- 사용자가 '지금 실행'으로 시작
  status     TEXT NOT NULL CHECK (status IN ('running', 'done', 'stopped', 'failed')),
  error_code TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX lounge_sessions_started ON lounge_sessions (started_at);
