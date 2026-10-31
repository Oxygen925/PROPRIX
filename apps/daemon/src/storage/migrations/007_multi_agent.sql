-- P4a 그룹챗·위임
-- 사용자 발화 1회당 에이전트 연쇄 응답 상한 (1..5)
ALTER TABLE rooms ADD COLUMN chain_limit INTEGER NOT NULL DEFAULT 3;

-- 도구를 호출한 에이전트, 위임 안에서 일어난 호출이면 그 위임 호출 id (위임 내역에 중첩해 보여 준다)
ALTER TABLE tool_calls ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE tool_calls ADD COLUMN parent_id TEXT NOT NULL DEFAULT '';
