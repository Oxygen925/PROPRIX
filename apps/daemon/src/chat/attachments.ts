// 메시지 첨부: 저장·조회와 모델 요청에 넣기
// - 텍스트(·PDF 에서 뽑은 글자)는 사용자 턴 글 뒤에 <attachment> 로 붙인다
// - 이미지는 사용자 턴에 input_image 로. store:false 라 매 요청 다시 보내므로 이력 전체에서 최근 HISTORY_IMAGES 개만
import type { Database } from "bun:sqlite";
import type { Attachment, AttachmentInput } from "@proprix/shared";
import type { ChatTurn } from "@proprix/siwc";

export const HISTORY_IMAGES = 4;
// 글만 없이 첨부만 보낸 턴의 글 (요청 입력이 비지 않게)
export const ATTACHMENT_ONLY_TEXT = "(attachment)";

export interface AttachmentRow {
  id: string;
  message_id: string;
  room_id: string;
  kind: "image" | "text";
  name: string;
  mime: string;
  data: string;
  size: number;
  created_at: number;
}

// 화면용: 이미지는 data 까지, 텍스트는 내용 없이 (열 때 content 로 받는다)
const info = (r: AttachmentRow): Attachment => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  mime: r.mime,
  size: r.size,
  data: r.kind === "image" ? r.data : "",
});

export class AttachmentStore {
  constructor(private readonly db: Database) {}

  add(messageId: string, roomId: string, inputs: AttachmentInput[], now = Date.now()): Attachment[] {
    const insert = this.db.query(
      `INSERT INTO attachments (id, message_id, room_id, kind, name, mime, data, size, created_at)
       VALUES ($id, $message, $room, $kind, $name, $mime, $data, $size, $now)`,
    );
    const rows: AttachmentRow[] = inputs.map((a) => ({
      id: crypto.randomUUID(),
      message_id: messageId,
      room_id: roomId,
      kind: a.kind,
      name: a.name,
      mime: a.mime,
      data: a.data,
      size: a.size,
      created_at: now,
    }));
    this.db.transaction(() => {
      for (const r of rows)
        insert.run({
          id: r.id,
          message: r.message_id,
          room: r.room_id,
          kind: r.kind,
          name: r.name,
          mime: r.mime,
          data: r.data,
          size: r.size,
          now: r.created_at,
        });
    })();
    return rows.map(info);
  }

  private rows(roomId: string): AttachmentRow[] {
    return this.db
      .query<AttachmentRow, { room: string }>(
        "SELECT * FROM attachments WHERE room_id = $room ORDER BY created_at, rowid",
      )
      .all({ room: roomId });
  }

  /** 메시지 id → 화면용 첨부 */
  infoByMessage(roomId: string): Map<string, Attachment[]> {
    const out = new Map<string, Attachment[]>();
    for (const r of this.rows(roomId)) out.set(r.message_id, [...(out.get(r.message_id) ?? []), info(r)]);
    return out;
  }

  /** 메시지 id → 원본 (요청 만들기·내보내기용) */
  fullByMessage(roomId: string): Map<string, AttachmentRow[]> {
    const out = new Map<string, AttachmentRow[]>();
    for (const r of this.rows(roomId)) out.set(r.message_id, [...(out.get(r.message_id) ?? []), r]);
    return out;
  }

  content(id: string): { id: string; name: string; data: string } | null {
    return (
      this.db
        .query<{ id: string; name: string; data: string }, { id: string }>(
          "SELECT id, name, data FROM attachments WHERE id = $id",
        )
        .get({ id }) ?? null
    );
  }
}

const safeName = (name: string) => name.replace(/["<>\n\r]/g, "_");

/** 사용자 턴 글에 텍스트 첨부를 붙인다 (닫는 태그로 빠져나오지 못하게) */
export function withTextAttachments(text: string, files: { name: string; data: string }[]): string {
  const parts = files.map(
    (f) =>
      `<attachment name="${safeName(f.name)}">\n${f.data.replaceAll("</attachment", "< /attachment")}\n</attachment>`,
  );
  return [text.trim() || (parts.length ? "" : ATTACHMENT_ONLY_TEXT), ...parts].filter(Boolean).join("\n\n");
}

/**
 * 이력 턴에 첨부를 넣는다. ids[i] 는 turns[i] 의 메시지 id (없으면 "").
 * 이미지는 뒤(최근)에서부터 HISTORY_IMAGES 개까지만
 */
export function attachToTurns(turns: ChatTurn[], ids: string[], files: Map<string, AttachmentRow[]>): ChatTurn[] {
  let imageBudget = HISTORY_IMAGES;
  const out = [...turns];
  for (let i = out.length - 1; i >= 0; i--) {
    const turn = out[i];
    const rows = files.get(ids[i] ?? "");
    if (turn?.role !== "user" || !rows?.length) continue;
    const texts = rows.filter((r) => r.kind === "text");
    const images: string[] = [];
    for (const r of rows) {
      if (r.kind !== "image" || imageBudget === 0) continue;
      images.push(r.data);
      imageBudget--;
    }
    const text = withTextAttachments(turn.text, texts);
    out[i] = images.length ? { ...turn, text, images } : { ...turn, text };
  }
  return out;
}
