-- UI 재설계 (사용자 결정 2026-10-29)
-- 승인 카드의 '항상 허용': 이 에이전트의 이 도구만 (JSON 배열 = 도구 이름). 편집기 저장과 따로 바꾼다
ALTER TABLE agents ADD COLUMN auto_approve_tools TEXT NOT NULL DEFAULT '[]';

-- 페르소나 이미지 아바타 (256px 로 줄인 data URL, '' = 이모지+색)
ALTER TABLE personas ADD COLUMN avatar_image TEXT NOT NULL DEFAULT '';
