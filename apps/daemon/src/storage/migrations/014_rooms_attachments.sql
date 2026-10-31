-- 방 고정·보관 (사용자 결정 2026-10-29: 고정 = 목록 맨 위, 보관 = 목록에서 숨김)
ALTER TABLE rooms ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

-- 메시지 첨부: image = 줄인 이미지 data URL (모델에 그대로), text = 파일 내용 (PDF 는 뽑은 글자)
-- 메시지가 지워지면 (다시 받기·방 삭제) 같이 지워진다
CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('image', 'text')),
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  data       TEXT NOT NULL,
  size       INTEGER NOT NULL, -- 원본 파일 크기 (바이트)
  created_at INTEGER NOT NULL
);
CREATE INDEX attachments_message ON attachments (message_id);
CREATE INDEX attachments_room ON attachments (room_id);
