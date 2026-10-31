-- 도구 실행 감사 로그 (P10b): 모든 방의 쓰기 도구 호출을 최신순으로 본다.
-- undone_at: 감사 화면에서 되돌린 시각 (도구가 만든 메모 삭제·리마인더 취소). 파일은 file_changes.restored_at 을 쓴다
CREATE INDEX tool_calls_kind_created ON tool_calls (kind, created_at);
ALTER TABLE tool_calls ADD COLUMN undone_at INTEGER;
