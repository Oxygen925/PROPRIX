-- P5a 선제 메시지: 리마인더 예약, 에이전트 정기 체크인, 무응답 안부
-- agent_id 는 FK 를 두지 않는다 (에이전트가 지워지면 보낼 때 방의 첫 참여자로)
CREATE TABLE reminders (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  text          TEXT NOT NULL,
  due_at        INTEGER NOT NULL, -- 다음에 보낼 시각
  repeat        TEXT NOT NULL CHECK (repeat IN ('none', 'daily', 'weekdays', 'weekly')),
  status        TEXT NOT NULL CHECK (status IN ('scheduled', 'done', 'cancelled')),
  fired_count   INTEGER NOT NULL DEFAULT 0,
  last_fired_at INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX reminders_due ON reminders (status, due_at);

-- 체크인 설정 (JSON {enabled, time "HH:MM", days [0=일..6]}) 과 마지막으로 처리한 날짜 (로컬 YYYY-MM-DD)
ALTER TABLE agents ADD COLUMN checkin TEXT NOT NULL DEFAULT '{"enabled":false,"time":"09:00","days":[0,1,2,3,4,5,6]}';
ALTER TABLE agents ADD COLUMN checkin_last TEXT NOT NULL DEFAULT '';

-- 선제 메시지 표시: '' | reminder | checkin | nudge
ALTER TABLE messages ADD COLUMN proactive TEXT NOT NULL DEFAULT '';

-- 스케줄러 내부 상태 (예: 안부를 보낸 기준 시각)
CREATE TABLE scheduler_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
