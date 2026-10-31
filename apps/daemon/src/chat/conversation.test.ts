// 대화 기능: 첨부(요청에 넣기·이미지 상한·다시 받기 cascade), 방 고정·보관, 검색, 마크다운 내보내기, 자동 백업
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentInput, Message, ServerEvent } from "@proprix/shared";
import type { AiRequest } from "@proprix/siwc";
import { AgentStore } from "../agents/store";
import type { StreamOptions, StreamResult } from "../auth/account";
import { SummaryService } from "../context/summary";
import { LlmGate } from "../llm/gate";
import { BackupService } from "../storage/backup";
import { migrate } from "../storage/db";
import { HISTORY_IMAGES } from "./attachments";
import { ChatService } from "./chat";
import { snippetOf } from "./search";
import { makeChatTools } from "./test-helpers";

function setup() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const calls: AiRequest[] = [];
  const llm = {
    async stream(req: AiRequest, opt: StreamOptions): Promise<StreamResult> {
      calls.push(structuredClone(req));
      const text = `reply ${calls.length}`;
      opt.onDelta(text);
      return {
        outcome: "completed",
        code: "",
        param: "",
        recovery: "none",
        http: 200,
        attempts: 1,
        chars: text.length,
        requestId: "",
        items: [],
      };
    },
  };
  const events: ServerEvent[] = [];
  const emit = (e: ServerEvent) => events.push(e);
  const gate = new LlmGate(db, () => {});
  const agents = new AgentStore(db);
  const summaries = new SummaryService(db, llm, gate, emit, (id) => agents.agent(id)?.name ?? "?", {
    recentMessages: 100,
    triggerChars: 1_000_000,
    hardCapMessages: 100,
  });
  const tools = makeChatTools(db, llm, gate, agents, emit);
  const chat = new ChatService(db, llm, gate, agents, summaries, tools, emit);
  const room = chat.createRoom("첫 방");
  if (typeof room === "string") throw new Error(room);
  return { db, chat, calls, events, room, memory: tools.memory };
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const image = (name = "a.png"): AttachmentInput => ({ kind: "image", name, mime: "image/png", size: 10, data: PNG });
const textFile = (name: string, data: string): AttachmentInput => ({
  kind: "text",
  name,
  mime: "text/plain",
  size: data.length,
  data,
});

async function say(chat: ChatService, roomId: string, text: string, files: AttachmentInput[] = []) {
  const r = chat.send(roomId, text, "m", files);
  if (typeof r === "string") throw new Error(r);
  await chat.idle(roomId);
  return r.user;
}

test("첨부: 텍스트는 글 뒤에 <attachment>, 이미지는 input 이미지로. 화면에는 텍스트 내용 없이", async () => {
  const { chat, calls, room } = setup();
  const user = await say(chat, room.id, "요약해줘", [textFile("메모.md", "# 제목\n내용 </attachment> 탈출"), image()]);
  expect(user.attachments.map((a) => [a.kind, a.name, a.data === ""])).toEqual([
    ["text", "메모.md", true],
    ["image", "a.png", false],
  ]);
  const turn = calls.at(-1)?.turns.at(-1);
  expect(turn?.text).toStartWith('요약해줘\n\n<attachment name="메모.md">\n# 제목');
  expect(turn?.text).toContain("< /attachment> 탈출");
  expect(turn?.images).toEqual([PNG]);
  // 다시 불러와도 같고, 텍스트 내용은 따로 받는다
  const loaded = chat.messages(room.id).find((m) => m.id === user.id) as Message;
  expect(loaded.attachments).toHaveLength(2);
  const textId = loaded.attachments[0]?.id ?? "";
  expect(chat.attachments.content(textId)?.data).toContain("# 제목");
});

test("첨부만 보내도 되고, 이력의 이미지는 최근 HISTORY_IMAGES 개만 다시 보낸다", async () => {
  const { chat, calls, room } = setup();
  for (let i = 0; i < HISTORY_IMAGES + 1; i++) await say(chat, room.id, "", [image(`${i}.png`)]);
  const turns = calls.at(-1)?.turns ?? [];
  expect(turns[0]?.text).toBe("(attachment)");
  expect(turns.filter((t) => t.images?.length).length).toBe(HISTORY_IMAGES);
  expect(turns[0]?.images).toBeUndefined(); // 가장 오래된 것부터 뺀다
});

test("다시 받기로 지운 메시지의 첨부는 같이 지워지고, 수정해도 첨부는 남는다", async () => {
  const { db, chat, room } = setup();
  const first = await say(chat, room.id, "하나", [image()]);
  const second = await say(chat, room.id, "둘", [image("b.png")]);
  const r = chat.rewind(room.id, first.id, "고친 하나", "m");
  if (typeof r === "string") throw new Error(r);
  await chat.idle(room.id);
  const count = (id: string) =>
    db.query<{ n: number }, { id: string }>("SELECT COUNT(*) AS n FROM attachments WHERE message_id = $id").get({ id })
      ?.n;
  expect(count(first.id)).toBe(1);
  expect(count(second.id)).toBe(0);
});

test("방 고정·보관", () => {
  const { chat, room } = setup();
  expect(chat.updateRoom(room.id, { pinned: true })).toMatchObject({ pinned: true, archived: false });
  expect(chat.updateRoom(room.id, { archived: true, pinned: false })).toMatchObject({ pinned: false, archived: true });
});

test("검색: 글자 그대로(한글 2글자·특수문자), 방·기간 거르기, 찾은 곳 앞뒤", async () => {
  const { chat, room } = setup();
  await say(chat, room.id, "내일 오후 3시에 치과 예약 100% 확정");
  const other = chat.createRoom("다른 방");
  if (typeof other === "string") throw new Error(other);
  await say(chat, other.id, "치과 말고 안과");
  expect(
    chat
      .search({ q: "치과" })
      .results.map((r) => r.roomTitle)
      .sort(),
  ).toEqual(["다른 방", "첫 방"]);
  expect(chat.search({ q: "치과", roomId: other.id }).results).toHaveLength(1);
  expect(chat.search({ q: "100%" }).results).toHaveLength(1);
  expect(chat.search({ q: "_" }).results).toHaveLength(0); // LIKE 와일드카드가 아니라 글자
  expect(chat.search({ q: "치과", from: Date.now() + 60_000 }).results).toHaveLength(0);
  expect(chat.search({ q: "  " }).results).toHaveLength(0);
  expect(snippetOf(`${"가".repeat(100)}찾기${"나".repeat(100)}`, "찾기")).toMatch(/^…가+찾기나+…$/);
});

test("마크다운 내보내기: 제목·날짜 구분·화자·첨부 이름", async () => {
  const { chat, room } = setup();
  await say(chat, room.id, "안녕", [image("사진.png")]);
  const md = chat.exportMarkdown(room.id) ?? "";
  expect(md).toStartWith("# 첫 방\n");
  expect(md).toMatch(/## \d{4}-\d{2}-\d{2}/);
  expect(md).toContain("**나**");
  expect(md).toContain("> 첨부: 사진.png");
  expect(md).toContain("**PROPRIX**");
  expect(chat.exportMarkdown(crypto.randomUUID())).toBeNull();
});

test("자동 백업: 하루에 한 번, 최근 keep 개만, 꺼져 있으면 안 함", () => {
  const dir = mkdtempSync(join(tmpdir(), "proprix-backup-"));
  try {
    const { db } = setup();
    let now = new Date(2026, 9, 29, 9, 0, 0).getTime();
    let settings = { enabled: true, keep: 2 };
    const b = new BackupService(
      db,
      dir,
      () => settings,
      () => now,
    );
    b.tick();
    expect(b.list()).toHaveLength(1);
    now += 60 * 60 * 1000; // 1시간 뒤 — 하루가 안 지나 건너뜀
    b.tick();
    expect(b.list()).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      now += 24 * 60 * 60 * 1000;
      b.runNow();
    }
    expect(b.list().map((x) => x.name)).toHaveLength(2);
    writeFileSync(join(dir, "다른 파일.txt"), "x"); // 백업 이름이 아닌 파일은 건드리지 않는다
    settings = { enabled: false, keep: 2 };
    now += 7 * 24 * 60 * 60 * 1000;
    b.tick();
    expect(b.list()).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("첨부만 보낸 메시지는 답을 다시 받아도 첨부 이름으로 기억을 찾는다", async () => {
  const { chat, room, memory } = setup();
  const queries: string[] = [];
  const forTurn = memory.forTurn.bind(memory);
  memory.forTurn = (agent, query) => {
    queries.push(query);
    return forTurn(agent, query);
  };
  const user = await say(chat, room.id, "", [textFile("요청서.md", "내용")]);
  const again = chat.rewind(room.id, user.id, undefined, "m");
  if (typeof again === "string") throw new Error(again);
  await chat.idle(room.id);
  expect(queries).toEqual(["요청서.md", "요청서.md"]);
});
