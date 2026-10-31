-- 반복 예약 작업 (P8): 정한 시각에 에이전트가 도구를 써서 일을 하고 고른 방에 보고한다.
-- schedule: {kind: daily|weekly|monthly|interval|cron, time, days, day, hours, cron, anchor} (JSON)
-- allowed_tools: 확인 없이 할 쓰기 도구 (JSON 배열). 그 밖의 확인 필요 도구는 실행 중 바로 거절한다 (사용자 결정 2026-10-29)
-- next_run_at: 다음 예정 시각 (NULL = 없음 — 꺼짐 등). 놓친 회차는 건너뛴다
-- created_by: 'user' 또는 대화 중 만든 에이전트 id
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  schedule      TEXT NOT NULL,
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  enabled       INTEGER NOT NULL DEFAULT 1,
  next_run_at   INTEGER,
  last_run_at   INTEGER,
  last_status   TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL DEFAULT 'user',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX tasks_due ON tasks (enabled, next_run_at);

-- 실행 기록. scheduled_for: 예정 시각 (NULL = '지금 실행'). reason: missed·budget·busy·paused·timeout·오류 코드
-- requests: 이 실행이 보낸 LLM 요청 수, rejected: 예약 작업이라 거절한 도구 호출 수
CREATE TABLE task_runs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  scheduled_for INTEGER,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'skipped', 'cancelled')),
  reason        TEXT NOT NULL DEFAULT '',
  message_id    TEXT NOT NULL DEFAULT '',
  requests      INTEGER NOT NULL DEFAULT 0,
  rejected      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX task_runs_task ON task_runs (task_id, started_at);
