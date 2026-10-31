import type { ApiError, ApiErrorCode, Recovery, ServerEvent } from "@proprix/shared";
import type { Server } from "bun";
import type { z } from "zod";

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden_origin: 403,
  forbidden_host: 421,
  not_found: 404,
  bad_request: 400,
  conflict: 409,
  upstream: 502,
  internal: 500,
};

export function apiError(code: ApiErrorCode, message: string, detail?: { code: string; recovery: Recovery }): Response {
  const body: ApiError = { error: { code, message, ...(detail ? { detail } : {}) } };
  return Response.json(body, { status: STATUS[code] });
}

// 본문을 스키마로 검증. 실패하면 400 Response
export async function readJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T> | Response> {
  let raw: unknown = {};
  const text = await req.text();
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      return apiError("bad_request", "JSON 형식이 잘못됐습니다");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return apiError("bad_request", parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

// WebSocket 구독자 전체에 이벤트를 보낸다. 서버가 붙기 전 이벤트는 버린다
export class EventHub {
  static readonly TOPIC = "events";
  private server: Server<unknown> | null = null;

  attach(server: Server<unknown>) {
    this.server = server;
  }

  emit(ev: ServerEvent) {
    this.server?.publish(EventHub.TOPIC, JSON.stringify(ev));
  }
}
