-- 서브 채팅 (P9b): 기존 대화에서 분기한 새 채팅. 분기 시점까지의 대화를 만들 때 복사해 두고 참조만 한다
-- (부모 대화에 쓰지 않고 새 장기 기억도 저장하지 않는다 — 사용자 결정 2026-10-29).
-- 부모에 FK 를 두지 않는다: 부모를 지워도 서브 채팅과 참조 사본은 남는다
ALTER TABLE rooms ADD COLUMN parent_room_id TEXT NOT NULL DEFAULT '';    -- 서브 채팅이면 부모 방 id
ALTER TABLE rooms ADD COLUMN parent_message_id TEXT NOT NULL DEFAULT ''; -- 분기한 메시지
ALTER TABLE rooms ADD COLUMN parent_title TEXT NOT NULL DEFAULT '';      -- 만들 때의 부모 제목
ALTER TABLE rooms ADD COLUMN reference TEXT NOT NULL DEFAULT '';         -- 만들 때 복사한 참조 (요약 + 분기 시점까지의 메시지)
