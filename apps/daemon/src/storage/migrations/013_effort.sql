-- 에이전트별 추론 강도 (reasoning.effort). '' = 자동 (보내지 않고 모델 기본값). 사용자 결정 2026-10-29
ALTER TABLE agents ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT '';
