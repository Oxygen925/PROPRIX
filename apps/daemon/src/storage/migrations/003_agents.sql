-- 페르소나: 성격·말투 템플릿 (desktop_pet persona.md 와 1:1)
CREATE TABLE personas (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  emoji            TEXT NOT NULL,
  color            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  body             TEXT NOT NULL,
  pet_character_id TEXT NOT NULL DEFAULT '',
  builtin          INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- 에이전트: 페르소나 + 역할 지시문 + 모델 (도구·메모리 범위·선제 설정은 이후 단계)
CREATE TABLE agents (
  id         TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE RESTRICT,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  builtin    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE room_members (
  room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);

-- 오래된 대화의 롤링 요약 (방마다 하나)
CREATE TABLE room_summaries (
  room_id       TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  summary       TEXT NOT NULL,
  covered_until INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

ALTER TABLE messages ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';

INSERT INTO personas (id, name, emoji, color, description, body, builtin, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'PROPRIX',
  '🧭',
  '#4f6bed',
  '기본 개인 비서',
  '- 성격: 차분하고 실용적이다. 사용자의 시간을 아낀다.
- 말투: 사용자의 언어로, 핵심부터 간결하게. 필요할 때만 자세히 설명한다.',
  1,
  0,
  0
);

INSERT INTO agents (id, persona_id, name, role, builtin, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'PROPRIX', '', 1, 0, 0);

-- 기존 방은 기본 에이전트와 대화하던 것으로 본다
INSERT INTO room_members (room_id, agent_id, position)
SELECT id, '00000000-0000-4000-8000-000000000002', 0 FROM rooms;
UPDATE messages SET agent_id = '00000000-0000-4000-8000-000000000002' WHERE role = 'assistant';
