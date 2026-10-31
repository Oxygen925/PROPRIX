// 장기 메모리 (범위: 공용 + 이 에이전트. 격리 에이전트는 공용을 바꿀 수 없다)
import { type Agent, type Memory, MemoryKind, SHARED_SCOPE } from "@proprix/shared";
import { z } from "zod";
import type { MemoryService } from "../../memory/service";
import { memoryScopes, writeScope } from "../../memory/store";
import { define, type LocalTool, nullable, obj } from "./define";

const view = (m: Memory, agent: Agent) => ({
  id: m.id,
  scope: m.scope === SHARED_SCOPE ? "shared" : m.scope === agent.id ? "agent" : "other",
  kind: m.kind,
  text: m.content,
  english: m.contentEn,
  importance: m.importance,
  updatedAt: new Date(m.updatedAt).toISOString(),
});

export function memoryTools(memory: MemoryService): LocalTool[] {
  return [
    define({
      info: {
        name: "memory_search",
        title: "기억 검색",
        description:
          "Search your long-term memories about the user by keyword. Empty query lists the most important ones.",
        kind: "read",
      },
      parameters: obj({
        query: { type: "string" },
        limit: nullable("integer", "Max results (1-20). null for 10."),
      }),
      args: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).nullable() }),
      run: async (a, ctx) => {
        const { read } = memoryScopes(ctx.agent);
        // 빈 검색어: 중요도·최근 순 목록 (중요도 3 이하도 포함)
        const found = a.query.trim()
          ? await memory.search(a.query, read, a.limit ?? 10)
          : memory.store.top(read, a.limit ?? 10);
        return { memories: found.map((m) => view(m, ctx.agent)) };
      },
    }),

    define({
      info: {
        name: "memory_save",
        title: "기억 저장",
        description:
          "Save something the user explicitly asked you to remember. scope shared = about the user in general, agent = only between you and the user. Never save secrets (passwords, card numbers, IDs).",
        kind: "write",
      },
      // 확인 없이 저장 (사용자 결정 2026-10-28): 기억 탭에서 지울 수 있고 같은 내용은 합친다
      trusted: true,
      parameters: obj({
        kind: { type: "string", enum: MemoryKind.options },
        scope: { type: "string", enum: ["shared", "agent"] },
        content: { type: "string", description: "One short sentence in the user's language." },
        content_en: { type: "string", description: "The same in English (proper nouns in original script)." },
        importance: nullable("integer", "1-5. null for 3."),
      }),
      args: z.object({
        kind: MemoryKind,
        scope: z.enum(["shared", "agent"]),
        content: z.string().trim().min(1).max(500),
        content_en: z.string().trim().max(800),
        importance: z.number().int().min(1).max(5).nullable(),
      }),
      run: (a, ctx) => {
        const scope = writeScope(ctx.agent, a.scope);
        const dup = memory.store.findDuplicate(scope, a.content, a.content_en);
        if (dup) return { exists: dup.id };
        const m = memory.store.create(
          {
            scope,
            kind: a.kind,
            content: a.content,
            contentEn: a.content_en,
            importance: a.importance ?? 3,
            validUntil: null,
          },
          ctx.roomId,
          false,
          ctx.messageId ?? "",
        );
        return { saved: m.id, scope: scope === SHARED_SCOPE ? "shared" : "agent" };
      },
    }),

    define({
      info: {
        name: "memory_forget",
        title: "기억 삭제",
        description: "Delete a long-term memory by id when the user asks you to forget it. Use memory_search first.",
        kind: "write",
      },
      parameters: obj({ id: { type: "string" } }),
      args: z.object({ id: z.string() }),
      run: (a, ctx) => {
        const m = memory.store.get(a.id);
        if (!m || !memory.visible(ctx.agent, m)) return { error: "memory not found" };
        if (!memory.canWrite(ctx.agent, m))
          return { error: "this shared memory is read-only for you (isolated agent)" };
        memory.store.delete(m.id);
        return { forgotten: m.id };
      },
    }),
  ];
}
