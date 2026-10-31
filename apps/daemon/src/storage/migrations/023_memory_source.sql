-- 기억 관리 강화 (P10e): 기억마다 출처 메시지 (자동 추출은 모델이 가리킨 메시지, memory_save 는 그 답).
-- 이전에 만든 기억은 '' (출처 대화로만 이동 — 사용자 결정 2026-10-29). FK 를 두지 않는다: 메시지·방을 지워도 기억은 남는다
ALTER TABLE memories ADD COLUMN source_message_id TEXT NOT NULL DEFAULT '';
CREATE INDEX memories_source_room ON memories (source_room_id);
