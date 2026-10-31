-- 리서치 확장 (P12): 복수 에이전트(결과 방식은 리서치마다), 실행 묶음, 행동 로그, 시작 주소 재방문용 내용 해시 (사용자 결정 2026-10-30).
-- 한 번 실행 = 같은 batch_id 의 실행 여러 개. 본문은 저장하지 않고 해시만 남긴다
ALTER TABLE research ADD COLUMN agent_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE research ADD COLUMN mode TEXT NOT NULL DEFAULT 'separate'; -- separate | merged | shared
UPDATE research SET agent_ids = json_array(agent_id);

ALTER TABLE research_runs ADD COLUMN batch_id TEXT NOT NULL DEFAULT '';
ALTER TABLE research_runs ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE research_runs ADD COLUMN role TEXT NOT NULL DEFAULT 'full'; -- full | collect | write | merge
UPDATE research_runs SET batch_id = id, agent_id = (SELECT agent_id FROM research WHERE research.id = research_runs.research_id);

ALTER TABLE research_pages ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE research_pages ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
UPDATE research_pages SET agent_id = (SELECT agent_id FROM research_runs WHERE research_runs.id = research_pages.run_id);
CREATE INDEX research_pages_seen_agent ON research_pages (research_id, agent_id, url);

-- 행동 로그: 검색어·주소·제목·까닭뿐 (비밀번호·쿠키·본문 없음). 실행당 300개까지
CREATE TABLE research_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX research_events_run ON research_events (run_id, at);
