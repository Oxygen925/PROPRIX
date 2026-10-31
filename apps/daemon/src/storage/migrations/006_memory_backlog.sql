-- 메모리 기능 이전의 과거 대화: 자동 추출하지 않고 사용자가 '기억 추출'을 누를 때만 처리한다 (사용자 결정 2026-10-28).
-- until 까지가 과거 대화, done_until 까지 수동 추출이 끝남. 다 끝나면 행을 지운다
CREATE TABLE memory_backlog (
  room_id    TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  until      INTEGER NOT NULL,
  done_until INTEGER NOT NULL DEFAULT 0
);

INSERT INTO memory_backlog (room_id, until)
SELECT m.room_id, MAX(m.created_at) FROM messages m
WHERE NOT EXISTS (SELECT 1 FROM memory_watermarks w WHERE w.room_id = m.room_id)
GROUP BY m.room_id;
