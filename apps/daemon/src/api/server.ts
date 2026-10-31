import { extname, resolve, sep } from "node:path";
import { API_PREFIX, ClientEvent, type HealthResponse, type ServerEvent, type SessionResponse } from "@proprix/shared";
import type { Server } from "bun";
import type { SecretStore } from "../auth/secret-store";
import { type DaemonConfig, HOST } from "../config";
import { apiError, EventHub } from "./http";
import type { ApiRoutes } from "./routes";
import { type AuthVia, Guard, sessionCookie } from "./security";
import type { VisualFrames } from "./visual-frames";

interface WsData {
  via: AuthVia;
}

export interface DaemonServer {
  server: Server<WsData>;
  guard: Guard;
  url: string;
  stop(): Promise<void>;
}

function send(ws: { send(data: string): unknown }, ev: ServerEvent) {
  ws.send(JSON.stringify(ev));
}

export function startServer(
  config: DaemonConfig,
  routes?: ApiRoutes,
  hub?: EventHub,
  sessions: SecretStore | null = null, // 브라우저 세션 보관 (다시 켜도 유지)
  frames?: VisualFrames,
): DaemonServer {
  let guard: Guard; // 실제 포트를 알아야 하므로 listen 직후 만든다 (port 0 = 자동)
  const warnedOrigins = new Set<string>();

  const handleApi = async (req: Request, path: string): Promise<Response> => {
    const via = guard.authenticate(req);
    if (!via) return apiError("unauthorized", "인증이 필요합니다");
    if (path === `${API_PREFIX}/session` && req.method === "GET") {
      const body: SessionResponse = { authenticated: true, via };
      return Response.json(body);
    }
    const res = routes ? await routes(req, path) : null;
    return res ?? apiError("not_found", `없는 API 입니다: ${req.method} ${path}`);
  };

  const server = Bun.serve<WsData>({
    hostname: HOST,
    port: config.port,
    async fetch(req, srv) {
      if (!guard.hostAllowed(req)) return apiError("forbidden_host", "허용되지 않은 Host 입니다");
      if (!guard.originAllowed(req)) {
        // 앱 창 origin 이 허용 목록과 다를 때 찾기 쉽게 (같은 origin 은 한 번만)
        const origin = req.headers.get("origin") ?? "";
        if (!warnedOrigins.has(origin)) {
          warnedOrigins.add(origin);
          console.warn(`[api] 허용되지 않은 Origin 거부: ${origin}`);
        }
        return apiError("forbidden_origin", "허용되지 않은 Origin 입니다");
      }

      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/auth/bootstrap" && req.method === "GET") {
        const sid = guard.redeemBootstrapCode(url.searchParams.get("code") ?? "");
        if (!sid)
          return new Response("링크가 만료되었거나 이미 사용됨. daemon 을 다시 실행해 새 링크를 받으세요.", {
            status: 401,
          });
        return new Response(null, { status: 302, headers: { location: "/", "set-cookie": sessionCookie(sid) } });
      }

      if (path === `${API_PREFIX}/health`) {
        const body: HealthResponse = { ok: true, name: "proprix", version: config.version };
        return Response.json(body, { headers: guard.corsHeaders(req) ?? {} });
      }

      // sandbox iframe 은 인증 정보를 붙일 수 없다. 주소가 내용의 해시라 내용을 아는 쪽만 연다
      if (frames && req.method === "GET" && path.startsWith(`${API_PREFIX}/visual-frame/`))
        return frames.response(path.slice(`${API_PREFIX}/visual-frame/`.length));

      if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
        // 앱 창(다른 origin)의 요청: preflight 는 인증 전에 답하고, 모든 응답(오류 포함)에 CORS 헤더
        const cors = guard.corsHeaders(req);
        if (req.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
        if (path === `${API_PREFIX}/ws`) {
          const via = guard.authenticateWs(req, url);
          if (!via) return apiError("unauthorized", "인증이 필요합니다");
          if (srv.upgrade(req, { data: { via } })) return undefined;
          return apiError("bad_request", "WebSocket upgrade 에 실패했습니다");
        }
        const res = await handleApi(req, path);
        if (cors) for (const [k, val] of Object.entries(cors)) res.headers.set(k, val);
        return res;
      }

      if (config.webDir) return serveStatic(config.webDir, path);
      return new Response("PROPRIX daemon — UI 가 빌드되지 않음 (bun run build:web)", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe(EventHub.TOPIC);
        send(ws, { type: "hello", version: config.version });
      },
      message(ws, raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        const ev = ClientEvent.safeParse(parsed);
        if (!ev.success) return;
        if (ev.data.type === "ping") send(ws, { type: "pong", at: Date.now() });
      },
    },
    error(err) {
      console.error("[api]", err);
      return apiError("internal", "서버 오류가 났습니다");
    },
  });

  const port = server.port ?? config.port;
  guard = new Guard(config.apiToken, port, config.extraOrigins, Date.now, sessions);
  hub?.attach(server as Server<unknown>);
  return {
    server,
    guard,
    url: `http://${HOST}:${port}`,
    stop: () => server.stop(true),
  };
}

// SPA 정적 서빙: webDir 밖 경로는 거부, 확장자 없는 경로는 index.html 로 (client-side routing)
export async function serveStatic(webDir: string, pathname: string): Promise<Response> {
  const root = resolve(webDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const target = resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(root + sep)) return new Response("Not Found", { status: 404 });

  const file = Bun.file(target);
  if (target !== root && (await file.exists())) return new Response(file);
  if (extname(decoded) === "") return new Response(Bun.file(resolve(root, "index.html")));
  return new Response("Not Found", { status: 404 });
}
