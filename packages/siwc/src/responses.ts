// Responses API 스트림(SSE) 해석과 요청 본문 생성.
import { isObject, parseObject, str } from "./protocol";

// ---- SSE (text/event-stream) 증분 파서: 청크가 어디서 잘려도 같은 결과 ----

export interface SseEvent {
  event: string; // event: 필드 (없으면 빈 문자열)
  data: string; // data: 줄들을 \n 으로 이은 값
}

export class SseParser {
  private pending = "";
  private event = "";
  private data = "";
  private hasData = false;
  private lastWasCr = false;

  feed(chunk: string): SseEvent[] {
    const out: SseEvent[] = [];
    for (const c of chunk) {
      if (c === "\n") {
        if (this.lastWasCr) {
          // \r\n 의 \n: 이미 \r 에서 줄을 끝냈다
          this.lastWasCr = false;
          continue;
        }
        this.line(this.pending, out);
        this.pending = "";
      } else if (c === "\r") {
        this.line(this.pending, out);
        this.pending = "";
        this.lastWasCr = true;
        continue;
      } else {
        this.pending += c;
      }
      this.lastWasCr = false;
    }
    return out;
  }

  // 스트림 끝: 빈 줄로 끝나지 않은 이벤트는 버린다 (SSE 규칙)
  finish(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.pending) this.line(this.pending, out);
    this.pending = "";
    this.event = "";
    this.data = "";
    this.hasData = false;
    return out;
  }

  private line(line: string, out: SseEvent[]) {
    if (line === "") {
      // 이벤트 경계
      if (this.hasData) out.push({ event: this.event, data: this.data });
      this.event = "";
      this.data = "";
      this.hasData = false;
      return;
    }
    if (line.startsWith(":")) return; // 주석
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      this.event = value;
    } else if (field === "data") {
      if (this.hasData) this.data += "\n";
      this.data += value;
      this.hasData = true;
    }
    // id·retry 는 쓰지 않는다
  }
}

// ---- 스트림 이벤트 해석 ----

export type StreamUpdate =
  | { kind: "ignore" }
  | { kind: "delta"; text: string }
  | { kind: "searching" } // 내장 웹 검색을 시작했다 (결과 항목은 끝나야 온다)
  | { kind: "completed" }
  | { kind: "failed"; code: string; message: string }
  | { kind: "incomplete"; reason: string }
  | { kind: "error"; code: string; message: string }
  // 완성된 출력 항목 (function_call·message·web_search_call·reasoning …). 도구 루프에서 그대로 다시 보낸다
  | { kind: "item"; item: Record<string, unknown> };

export function interpretEvent(e: SseEvent): StreamUpdate {
  if (e.data === "[DONE]") return { kind: "ignore" };
  const j = parseObject(e.data);
  const type = j && typeof j.type === "string" ? j.type : e.event;
  switch (type) {
    case "response.output_text.delta":
      return j && typeof j.delta === "string" ? { kind: "delta", text: j.delta } : { kind: "ignore" };
    case "response.completed":
      return { kind: "completed" };
    case "response.output_item.done":
      return j && isObject(j.item) ? { kind: "item", item: j.item } : { kind: "ignore" };
    case "response.output_item.added":
      return j && isObject(j.item) && j.item.type === "web_search_call" ? { kind: "searching" } : { kind: "ignore" };
    case "response.web_search_call.in_progress":
    case "response.web_search_call.searching":
      return { kind: "searching" };
    case "response.failed": {
      const err = isObject(j?.response) ? j.response.error : undefined;
      return { kind: "failed", code: str(err, "code"), message: str(err, "message") };
    }
    case "response.incomplete": {
      const details = isObject(j?.response) ? j.response.incomplete_details : undefined;
      return { kind: "incomplete", reason: str(details, "reason") };
    }
    case "error": {
      const err = j && isObject(j.error) ? j.error : j;
      return { kind: "error", code: str(err, "code"), message: str(err, "message") };
    }
    default:
      return { kind: "ignore" };
  }
}

// ---- 요청 ----

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  images?: string[]; // user 턴에 붙는 이미지 (data URL)
}

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

// function 도구 선언 (strict: 모든 속성 required + additionalProperties:false 여야 함 — 선택값은 null 허용 타입으로)
export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

export type ToolSpec = FunctionTool | { type: "web_search" };

export interface AiRequest {
  model: string;
  instructions: string;
  turns: ChatTurn[];
  // turns 뒤에 붙는 원본 항목: 도구 루프에서 받은 출력 항목 그대로 + function_call_output (store:false 라 매번 다시 보냄)
  items?: Record<string, unknown>[];
  tools?: ToolSpec[];
  reasoningEffort?: ReasoningEffort;
}

// store:false, stream:true 필수. system role 항목은 거부되므로 instructions 로 보낸다.
// temperature·max_output_tokens·previous_response_id·user·metadata 등 미지원 필드는 보내지 않는다 (preview-limitations).
// 도구가 있으면 reasoning 항목을 다음 단계에 넘길 수 있게 암호화된 reasoning 을 요청한다 (실계정 확인 2026-10-28: 허용됨)
export function buildResponsesRequest(r: AiRequest): string {
  const body: Record<string, unknown> = {
    model: r.model,
    input: [
      ...r.turns.map((t) =>
        t.images?.length
          ? {
              role: t.role,
              content: [
                { type: "input_text", text: t.text.toWellFormed() },
                ...t.images.map((url) => ({ type: "input_image", image_url: url })),
              ],
            }
          : { role: t.role, content: t.text.toWellFormed() },
      ),
      ...(r.items ?? []),
    ],
    store: false,
    stream: true,
  };
  if (r.instructions) body.instructions = r.instructions.toWellFormed();
  if (r.reasoningEffort) body.reasoning = { effort: r.reasoningEffort };
  if (r.tools?.length) {
    body.tools = r.tools;
    body.parallel_tool_calls = false; // 한 번에 하나씩: 쓰기 도구 확인을 호출마다 받기 쉽게
    body.include = ["reasoning.encrypted_content"];
  }
  return JSON.stringify(body);
}

export interface Source {
  url: string;
  title: string;
}

// message 항목의 url_citation 주석 → 출처 목록 (중복 제거)
export function citationsOf(items: readonly Record<string, unknown>[]): Source[] {
  const out = new Map<string, Source>();
  for (const item of items) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isObject(part) || !Array.isArray(part.annotations)) continue;
      for (const a of part.annotations) {
        if (str(a, "type") !== "url_citation") continue;
        const url = str(a, "url");
        if (/^https?:\/\//.test(url) && !out.has(url)) out.set(url, { url, title: str(a, "title") || url });
      }
    }
  }
  return [...out.values()];
}

export interface ModelInfo {
  slug: string;
  displayName: string;
  efforts: string[]; // 지원 추론 강도 (목록에 없으면 빈 배열)
}

// GET /v1/models → models[] 중 visibility == "list" (실계정 검증된 형식)
export function parseModels(body: string): ModelInfo[] {
  const j = parseObject(body);
  if (!j || !Array.isArray(j.models)) return [];
  const out: ModelInfo[] = [];
  for (const m of j.models) {
    if (str(m, "visibility") !== "list") continue;
    const slug = str(m, "slug");
    if (!slug) continue;
    // supported_reasoning_levels: [{effort}] 또는 [문자열] (있을 때만 — 실계정 형식 미확인이라 없어도 동작)
    const levels = isObject(m) && Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    const efforts = levels
      .map((l: unknown) => (typeof l === "string" ? l : str(l, "effort")))
      .filter((e: string) => e !== "");
    out.push({ slug, displayName: str(m, "display_name") || slug, efforts });
  }
  return out;
}
