-- 에이전트 팀 프리셋 (P10d): 기존 에이전트 묶음(참가자·순서·연쇄 상한)만 저장한다. 역할·도구는 각 에이전트 설정을 그대로
-- (사용자 결정 2026-10-29). /team 이름 이나 새 그룹 대화에서 그 구성으로 새 대화를 연다.
-- 에이전트를 지우면 팀에서 빠진다 (2명 미만이 된 팀은 남겨 두고 화면에 '참가자 부족')
CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL UNIQUE,     -- 대소문자·앞뒤 공백을 무시한 이름 (겹칠 수 없음)
  description TEXT NOT NULL DEFAULT '',
  agent_ids   TEXT NOT NULL,            -- JSON 배열, 답변·발언 순서
  chain_limit INTEGER NOT NULL DEFAULT 3,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
