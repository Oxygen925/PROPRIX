// 메모 도구. 화면·모델에 나가는 순서를 지키려고 시각·시각화 도구도 여기서 메모 사이에 둔다
import { NoteInput, VISUAL_CONTENT_MAX, VISUAL_TOOL } from "@proprix/shared";
import { z } from "zod";
import type { NoteStore } from "../notes";
import { define, type LocalTool, nullable, obj, ToolInputError } from "./define";

// 시각화 (show_visual): 화면에 보일 뿐 바깥에 남는 변화가 없어 read. 네트워크가 막힌 sandbox 라 외부 주소는 미리 거절한다
const VISUAL_DESCRIPTION =
  "Show a visual inside your reply: a chart, diagram, table or small interactive UI. Pass one self-contained SVG " +
  "or HTML fragment (no <html>/<head>). It runs in a sandbox with scripts but no network: no external scripts, " +
  "styles, fonts, images or requests; inline everything (draw charts yourself with SVG or canvas). Colors: use CSS " +
  "variables var(--pv-text), var(--pv-text-2), var(--pv-muted), var(--pv-bg), var(--pv-surface), var(--pv-line), " +
  "var(--pv-accent) and var(--pv-c1) … var(--pv-c6) for series; the font is inherited. Keep it compact; the height " +
  "fits the content. For a button that should send a choice back to the chat, call proprix.send('text') (the user " +
  "confirms first). After the call, continue your reply in text without repeating the visual's contents.";

// 외부 주소 (SVG·XHTML 이름공간 www.w3.org 는 제외). 네트워크는 CSP 로도 막히지만 모델에게 바로 알려 준다
export function externalUrl(content: string): string | null {
  for (const m of content.matchAll(/https?:\/\/[^\s"'<>)`]+/gi))
    if (!/^https?:\/\/www\.w3\.org\//i.test(m[0])) return m[0];
  const rel = /\b(?:src|href|action|xlink:href)\s*=\s*["']?\s*\/\/[^\s"'<>]+/i.exec(content);
  return rel ? rel[0] : null;
}

export function noteTools(notes: NoteStore): LocalTool[] {
  return [
    define({
      info: {
        name: "current_time",
        title: "현재 시각",
        description: "Get the current local date and time.",
        kind: "read",
      },
      parameters: obj({}),
      args: z.object({}),
      run: () => ({
        now: new Date().toString(),
        iso: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    }),

    define({
      info: {
        name: "note_search",
        title: "메모 검색",
        description: "Search the user's local notes by keyword (title or body). Empty query lists recent notes.",
        kind: "read",
      },
      parameters: obj({
        query: nullable("string", "Keyword to search for. null for recent notes."),
        limit: nullable("integer", "Max results (1-20). null for 10."),
      }),
      args: z.object({ query: z.string().nullable(), limit: z.number().int().min(1).max(20).nullable() }),
      run: (a) => ({
        notes: notes.list(a.query ?? "", a.limit ?? 10).map((n) => ({
          id: n.id,
          title: n.title,
          body: n.body.length > 500 ? `${n.body.slice(0, 500)}…` : n.body,
          updatedAt: new Date(n.updatedAt).toISOString(),
        })),
      }),
    }),

    define({
      info: { name: VISUAL_TOOL, title: "시각화 표시", description: VISUAL_DESCRIPTION, kind: "read" },
      parameters: obj({
        title: { type: "string", description: "Short title shown above the visual" },
        format: { type: "string", enum: ["svg", "html"] },
        content: { type: "string", description: "The SVG element or HTML fragment" },
      }),
      args: z.object({
        title: z.string().trim().min(1).max(80),
        format: z.enum(["svg", "html"]),
        content: z.string().min(1).max(VISUAL_CONTENT_MAX),
      }),
      // 방에서 직접 말하는 에이전트만 (위임·작업자의 결과는 사용자에게 바로 보이지 않는다)
      topLevelOnly: true,
      run: (a, ctx) => {
        const url = externalUrl(a.content);
        if (url)
          throw new ToolInputError(
            `external URL not allowed, the visual has no network: ${url.slice(0, 80)}. Inline everything.`,
          );
        if (a.format === "svg" && !/<svg[\s>]/i.test(a.content))
          throw new ToolInputError("format svg needs an <svg> element");
        return { shown: true, outside: !!ctx.outside };
      },
    }),

    define({
      info: { name: "note_create", title: "메모 저장", description: "Create a new note for the user.", kind: "write" },
      parameters: obj({ title: { type: "string" }, body: { type: "string" } }),
      args: NoteInput,
      run: (a, ctx) => ({ created: notes.create(a, ctx.agent.id).id }),
    }),

    define({
      info: {
        name: "note_update",
        title: "메모 편집",
        description: "Update a note's title and/or body by id. Use note_search first to find the id.",
        kind: "write",
      },
      parameters: obj({
        id: { type: "string" },
        title: nullable("string", "New title, or null to keep."),
        body: nullable("string", "New body (replaces the whole body), or null to keep."),
      }),
      args: z.object({
        id: z.string(),
        title: NoteInput.shape.title.nullable(),
        body: NoteInput.shape.body.unwrap().nullable(),
      }),
      run: (a) => {
        const n = notes.update(a.id, { title: a.title ?? undefined, body: a.body ?? undefined });
        return n ? { updated: n.id } : { error: "note not found" };
      },
    }),

    define({
      info: {
        name: "note_delete",
        title: "메모 삭제",
        description: "Delete a note by id. Use note_search first to find the id.",
        kind: "write",
      },
      parameters: obj({ id: { type: "string" } }),
      args: z.object({ id: z.string() }),
      run: (a) => (notes.delete(a.id) ? { deleted: a.id } : { error: "note not found" }),
    }),
  ];
}
