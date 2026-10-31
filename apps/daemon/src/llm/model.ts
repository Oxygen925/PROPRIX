// 어떤 모델로 보낼지 정하는 공통 규칙
import type { Database } from "bun:sqlite";

// 전역 설정, 비어 있으면 대화에 마지막으로 쓴 모델
export const pickModel = (settings: { model: string }, lastModel: () => string) => settings.model || lastModel();

// 대화에 마지막으로 쓴 모델 (roomId 를 주면 그 방에서, 없으면 전체에서)
export function lastUsedModel(db: Database, roomId = ""): string {
  return (
    db
      .query<{ model: string }, { room: string }>(
        `SELECT model FROM messages WHERE model != '' AND ($room = '' OR room_id = $room)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get({ room: roomId })?.model ?? ""
  );
}
