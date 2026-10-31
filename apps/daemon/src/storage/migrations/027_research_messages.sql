-- 리서치 화면의 대화 (P12d, 사용자 결정 2026-10-30): 추가 지시로 실행, 결과로 이어서 대화.
-- 대화방 밖이라 대화 이력·장기 기억에 들어가지 않는다
CREATE TABLE research_messages (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- user | agent
  kind TEXT NOT NULL, -- instruction | question | answer
  agent_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done', -- done | streaming | failed
  at INTEGER NOT NULL
);
CREATE INDEX research_messages_by_research ON research_messages (research_id, at);
