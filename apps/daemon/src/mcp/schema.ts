// MCP 도구 정의·결과 다루기: 정의 해시(정렬한 JSON), 모델에 보낼 스키마 정리, 노출 이름, 결과를 글로
import type { Tool } from "@modelcontextprotocol/client";
import { MCP_PREFIX } from "@proprix/shared";
import { sha256 } from "../tools/files";

export const MCP_OUTPUT_MAX = 30_000;
const NAME_MAX = 64;

/** 키를 정렬한 JSON (같은 정의면 순서와 관계없이 같은 글) */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** 고정·비교할 정의: 이름·제목·설명·입출력 스키마·annotations (_meta·아이콘은 빼서 흔들리지 않게) */
export function definitionOf(t: Tool): Record<string, unknown> {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    annotations: t.annotations,
  };
}

export const definitionHash = (def: unknown) => sha256(canonical(def));

/** 모델에 보낼 parameters: 맨 위는 object, $schema 는 뺀다 */
export function normalizeSchema(schema: unknown): Record<string, unknown> {
  const s = schema && typeof schema === "object" ? { ...(schema as Record<string, unknown>) } : {};
  delete s.$schema;
  if (s.type !== "object") return { type: "object", properties: {} };
  if (!s.properties || typeof s.properties !== "object") s.properties = {};
  return s;
}

/** mcp__<server>__<tool> (영문·숫자·_- 만, 64자). 길면 자르고 짧은 해시를 붙인다. 겹치면 _2, _3 … */
export function exposedName(server: string, tool: string, taken: (name: string) => boolean): string {
  const clean = tool.replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
  const head = `${MCP_PREFIX}${server}__`;
  let base = head + clean;
  if (base.length > NAME_MAX) base = `${base.slice(0, NAME_MAX - 9)}_${sha256(tool).slice(0, 8)}`;
  let name = base;
  for (let i = 2; taken(name); i++) {
    const suffix = `_${i}`;
    name = base.slice(0, NAME_MAX - suffix.length) + suffix;
  }
  return name;
}

interface ContentItem {
  type: string;
  text?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
}

/** 도구 결과 → 모델에 돌려줄 JSON 글. 이미지·소리는 자리표시만 (함수 결과는 글만 보낼 수 있다) */
export function formatResult(r: { content?: unknown; structuredContent?: unknown; isError?: boolean }): {
  ok: boolean;
  output: string;
} {
  const parts: string[] = [];
  for (const c of (Array.isArray(r.content) ? r.content : []) as ContentItem[]) {
    if (c.type === "text") parts.push(c.text ?? "");
    else if (c.type === "image") parts.push(`[image omitted: ${c.mimeType ?? "unknown"}]`);
    else if (c.type === "audio") parts.push(`[audio omitted: ${c.mimeType ?? "unknown"}]`);
    else if (c.type === "resource_link") parts.push(`[resource link] ${c.name ?? ""} ${c.uri ?? ""}`.trim());
    else if (c.type === "resource")
      parts.push(
        c.resource?.text ?? `[binary resource omitted: ${c.resource?.uri ?? ""} ${c.resource?.mimeType ?? ""}]`,
      );
    else parts.push(`[${c.type} content omitted]`);
  }
  const body: Record<string, unknown> = { content: parts.join("\n\n") };
  if (r.structuredContent !== undefined) body.structured = r.structuredContent;
  if (r.isError) body.error = true;
  let output = JSON.stringify(body);
  if (output.length > MCP_OUTPUT_MAX)
    output = `${output.slice(0, MCP_OUTPUT_MAX)}…(truncated ${output.length - MCP_OUTPUT_MAX} chars)`;
  return { ok: !r.isError, output };
}
