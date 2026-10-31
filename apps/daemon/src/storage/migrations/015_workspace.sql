-- P7a 작업 폴더 (사용자 결정 2026-10-29: 방마다 하나, 읽기·쓰기 + 명령 실행)
-- workspace: 절대 경로 ('' = 없음). rules: 사용자가 더한 규칙 {"deny": [glob], "readonly": [glob]} (기본 규칙은 코드에)
-- shell_enabled: 명령 실행은 폴더를 정해도 기본 꺼짐, 따로 켠다
ALTER TABLE rooms ADD COLUMN workspace TEXT NOT NULL DEFAULT '';
ALTER TABLE rooms ADD COLUMN workspace_rules TEXT NOT NULL DEFAULT '{}';
ALTER TABLE rooms ADD COLUMN shell_enabled INTEGER NOT NULL DEFAULT 0;

-- 승인 카드에 보여 줄 미리보기 (파일 diff · 명령 요약)
ALTER TABLE tool_calls ADD COLUMN preview TEXT NOT NULL DEFAULT '';

-- 파일 변경 기록과 복구: 바꾸기 직전 원본을 snapshots/ 에 보관 (지우기는 실제 삭제 대신 옮김)
-- before_hash '' = 새 파일, after_hash '' = 지움, snapshot '' = 원본 없음 (새 파일)
CREATE TABLE file_changes (
  id          TEXT PRIMARY KEY,
  call_id     TEXT NOT NULL,
  room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  path        TEXT NOT NULL, -- 작업 폴더 기준 상대 경로
  op          TEXT NOT NULL CHECK (op IN ('write', 'edit', 'delete')),
  before_hash TEXT NOT NULL,
  after_hash  TEXT NOT NULL,
  snapshot    TEXT NOT NULL,
  size        INTEGER NOT NULL, -- 보관한 원본 크기 (바이트)
  created_at  INTEGER NOT NULL,
  restored_at INTEGER
);
CREATE INDEX file_changes_call ON file_changes (call_id);
CREATE INDEX file_changes_room_created ON file_changes (room_id, created_at);
