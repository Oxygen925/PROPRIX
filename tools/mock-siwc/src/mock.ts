// 모의 SIWC 서버: 127.0.0.1 전용. 실제 OpenAI 와 통신하지 않고 discovery·인가·토큰·JWKS·revoke·models·responses(SSE)를
// 흉내 낸다. 시나리오는 모드로 바꾼다 (desktop_pet tools/mock-siwc 의 모드 체계를 따름).
//   POST /mock/mode {"responses":"usage_limit"} · {"reset":true}   GET /mock/stats
import {
  base64UrlEncode,
  DYNAMIC_CLIENT_ID,
  isObject,
  parseObject,
  pkceChallenge,
  RESOURCE,
  randomToken,
  SCOPES,
  str,
} from "@proprix/siwc";

export interface MockModes {
  auth: "ok" | "deny" | "badstate" | "noplan";
  refresh: "ok" | "unavailable" | "invalid_grant";
  refresh_id: "none" | "same" | "bad_sub"; // 갱신 응답에 ID 토큰을 넣을지
  access_ttl: number; // 초
  responses:
    | "ok"
    | "unavailable" // 503 (스트림 전)
    | "invalid_user" // 401
    | "not_eligible" // 403
    | "usage_limit_http" // 429 (스트림 전)
    | "usage_limit" // 스트림 도중 response.failed
    | "drop" // response.completed 없이 끊김
    | "incomplete"
    | "slow"; // 조각마다 100ms
  revoke: "ok" | "fail";
  // >0 이면 다음 N 번의 responses 요청에만 responses 모드를 적용하고 이후 ok (503 백오프 시험). 0 = 계속 적용
  responses_times: number;
}

const DEFAULT_MODES: MockModes = {
  auth: "ok",
  refresh: "ok",
  refresh_id: "none",
  access_ttl: 3600,
  responses: "ok",
  revoke: "ok",
  responses_times: 0,
};

export interface MockStats {
  counts: Record<string, number>;
  lastAuthorize: Record<string, string | boolean> | null;
  lastResponsesBody: unknown;
  responsesBodies: unknown[]; // reset 이후 받은 responses 요청 본문 전부 (도구 루프 단계 확인용)
}

interface PendingCode {
  clientId: string;
  challenge: string;
  nonce: string;
  redirect: string;
  scope: string;
}

export interface MockSiwc {
  url: string;
  modes: MockModes;
  stats: MockStats;
  setModes(m: Partial<MockModes>): void;
  reset(): void;
  stop(): Promise<void>;
}

const now = () => Math.floor(Date.now() / 1000);
const enc = (o: object) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
const json = (status: number, body: unknown) => Response.json(body, { status });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startMockSiwc(port = 0): Promise<MockSiwc> {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const kid = "mock-key-1";
  const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid, use: "sig", alg: "RS256" };

  let base = "";
  let modes: MockModes = { ...DEFAULT_MODES };
  const stats: MockStats = { counts: {}, lastAuthorize: null, lastResponsesBody: null, responsesBodies: [] };
  const codes = new Map<string, PendingCode>();
  const access = new Map<string, number>(); // token → 만료 시각
  const refresh = new Map<string, string>(); // token → client_id
  let clientSeq = 0;

  const count = (k: string) => {
    stats.counts[k] = (stats.counts[k] ?? 0) + 1;
  };

  async function signJwt(payload: object): Promise<string> {
    const input = `${enc({ alg: "RS256", kid, typ: "JWT" })}.${enc(payload)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(input));
    return `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
  }

  async function issueTokens(clientId: string, scope: string, nonce: string, idSub: string | null) {
    const ttl = modes.access_ttl;
    const at = `mock_at_${randomToken(16)}`;
    const rt = `mock_rt_${randomToken(16)}`;
    access.set(at, now() + ttl);
    refresh.set(rt, clientId);
    const body: Record<string, unknown> = {
      access_token: at,
      refresh_token: rt,
      token_type: "Bearer",
      expires_in: ttl,
      scope,
      earliest_refresh_at: now(),
    };
    if (idSub)
      body.id_token = await signJwt({
        iss: base,
        aud: clientId,
        sub: idSub,
        email: "tester@example.test",
        ...(nonce ? { nonce } : {}),
        iat: now(),
        exp: now() + 3600,
      });
    return body;
  }

  function bearerOk(req: Request): boolean {
    const auth = req.headers.get("authorization") ?? "";
    const exp = auth.startsWith("Bearer ") ? access.get(auth.slice(7)) : undefined;
    if (exp === undefined || exp < now()) {
      count("unauthorized");
      return false;
    }
    return true;
  }

  function authorize(url: URL): Response {
    count("authorize");
    const q = url.searchParams;
    const get = (k: string) => q.get(k) ?? "";
    const clientId = get("client_id");
    const redirect = get("redirect_uri");
    stats.lastAuthorize = {
      client_id: clientId,
      agent_name_hint: get("agent_name_hint"),
      ext_agent_host_id: get("ext_agent_host_id"),
      id_token_hint: get("id_token_hint") !== "",
      login_hint: get("login_hint") !== "",
      prompt: get("prompt"),
      redirect_uri: redirect,
    };
    const ok =
      get("response_type") === "code" &&
      redirect.startsWith("http://127.0.0.1:") &&
      redirect.endsWith("/auth/callback") &&
      get("scope") === SCOPES &&
      get("resource") === RESOURCE &&
      get("code_challenge_method") === "S256" &&
      get("state") !== "" &&
      get("nonce") !== "" &&
      get("code_challenge") !== "" &&
      get("ext_agent_host_id").startsWith("urn:uuid:");
    if (!ok) {
      count("authorize_rejected");
      return new Response("bad authorize request", { status: 400 });
    }
    let issued = clientId;
    if (clientId === DYNAMIC_CLIENT_ID) {
      if (!get("agent_name_hint")) return new Response("agent_name_hint required", { status: 400 });
      issued = `oaiapp_mock${++clientSeq}`;
    }
    const loc = new URL(redirect);
    loc.searchParams.set("state", modes.auth === "badstate" ? "wrong-state" : get("state"));
    if (modes.auth === "deny") {
      loc.searchParams.set("error", "access_denied");
    } else {
      const scope = modes.auth === "noplan" ? "openid profile email offline_access" : SCOPES;
      const code = `mock_code_${randomToken(12)}`;
      codes.set(code, { clientId: issued, challenge: get("code_challenge"), nonce: get("nonce"), redirect, scope });
      loc.searchParams.set("code", code);
      loc.searchParams.set("scope", scope);
      if (clientId === DYNAMIC_CLIENT_ID) loc.searchParams.set("client_id", issued);
    }
    return new Response("redirect", { status: 302, headers: { location: loc.toString() } });
  }

  async function token(req: Request): Promise<Response> {
    const f = new URLSearchParams(await req.text());
    const get = (k: string) => f.get(k) ?? "";
    if (get("resource") !== RESOURCE) return json(400, { error: "invalid_target" });
    if (get("grant_type") === "authorization_code") {
      count("token_code");
      const pc = codes.get(get("code"));
      if (
        !pc ||
        pc.clientId !== get("client_id") ||
        pc.redirect !== get("redirect_uri") ||
        pkceChallenge(get("code_verifier")) !== pc.challenge
      )
        return json(400, { error: "invalid_grant" });
      codes.delete(get("code"));
      return json(200, await issueTokens(pc.clientId, pc.scope, pc.nonce, "mock-user-1"));
    }
    if (get("grant_type") === "refresh_token") {
      count("token_refresh");
      if (modes.refresh === "unavailable") return json(503, { error: "temporarily_unavailable" });
      const client = refresh.get(get("refresh_token"));
      if (modes.refresh === "invalid_grant" || client === undefined || client !== get("client_id"))
        return json(400, { error: "invalid_grant" });
      refresh.delete(get("refresh_token")); // 교체: 이전 refresh 토큰은 무효
      const sub = modes.refresh_id === "none" ? null : modes.refresh_id === "bad_sub" ? "someone-else" : "mock-user-1";
      const body = await issueTokens(client, SCOPES, "", sub);
      delete body.scope;
      return json(200, body);
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  async function revoke(req: Request): Promise<Response> {
    count("revoke");
    if (modes.revoke === "fail") return new Response("revoke failed", { status: 500 });
    const f = new URLSearchParams(await req.text());
    if (f.get("token_type_hint") === "refresh_token") refresh.delete(f.get("token") ?? "");
    return new Response(null, { status: 200 });
  }

  async function responses(req: Request): Promise<Response> {
    count("responses");
    if (!bearerOk(req)) return json(401, { detail: "token not accepted" });
    const text = await req.text();
    const body = parseObject(text);
    stats.lastResponsesBody = body;
    stats.responsesBodies.push(body);
    if (body?.store !== false || body.stream !== true)
      return json(400, { error: { code: "invalid_request", message: "store:false, stream:true 필수" } });

    const mode = modes.responses;
    if (modes.responses_times > 0 && --modes.responses_times === 0) modes.responses = "ok";
    if (mode === "unavailable") return json(503, { error: { code: "subscription_sharing_usage_unavailable" } });
    if (mode === "invalid_user") return json(401, { error: { code: "subscription_sharing_invalid_user" } });
    if (mode === "not_eligible") return json(403, { error: { code: "subscription_sharing_user_not_eligible" } });
    if (mode === "usage_limit_http")
      return json(429, { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } });

    // 기본: 마지막 user 입력을 되돌려준다. 도구 시나리오는 user 입력 안의 표시로 고른다
    //   [tool:NAME {json}]      → function_call 만
    //   [say+tool:NAME {json}]  → 짧은 텍스트 뒤 function_call (텍스트 + 호출이 한 응답에 섞인 경우)
    //   [search]                → web_search_call + url_citation 주석이 달린 답변 (tools 에 web_search 가 있을 때)
    //   마지막 입력이 function_call_output 이면 → "tool result: <output>"
    //   리서치 (P11b): MOCK_SEARCH_URLS=주소,주소 면 web_search 요청마다 그 주소를 출처로, 검색어·페이지 요약 요청은 JSON 으로
    const input = Array.isArray(body.input) ? body.input : [];
    const last = input.at(-1);
    const lastUser = [...input].reverse().find((t) => isObject(t) && t.role === "user");
    // content 가 배열이면 (이미지 첨부) 글 부분을 잇고 이미지 수를 덧붙인다
    const content = isObject(lastUser) ? lastUser.content : undefined;
    const userText = Array.isArray(content)
      ? [
          ...content.filter((p) => isObject(p) && p.type === "input_text").map((p) => str(p, "text")),
          ...(content.some((p) => isObject(p) && p.type === "input_image")
            ? [`[image×${content.filter((p) => isObject(p) && p.type === "input_image").length}]`]
            : []),
        ].join(" ")
      : str(lastUser, "content");
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasTool = (name: string) => tools.some((t) => isObject(t) && (t.name === name || t.type === name));
    const toolMatch = findToolMarker(userText);
    const afterTool = isObject(last) && last.type === "function_call_output";
    const call = !afterTool && toolMatch && hasTool(toolMatch.name) ? toolMatch : null;
    const searchUrls = (process.env.MOCK_SEARCH_URLS ?? "").split(",").filter(Boolean);
    const search =
      !afterTool && !call && (userText.includes("[search]") || searchUrls.length > 0) && hasTool("web_search");
    const instructions = str(body, "instructions");

    let reply = `echo: ${userText}`;
    if (afterTool) reply = `tool result: ${str(last, "output")}`;
    else if (call) reply = call.say ? "확인해 볼게요." : "";
    else if (search) reply = searchUrls.length ? "찾은 페이지입니다." : "Bun 공식 사이트는 bun.sh 입니다.";
    else if (instructions.startsWith("You plan web searches")) reply = '{"queries": ["모의 검색어"]}';
    else if (instructions.startsWith("You read one web page"))
      reply = JSON.stringify({
        relevant: !userText.includes("광고"),
        summary: `모의 요약: ${(userText.split("<page>\n")[1] ?? "").split("\n")[0]}`,
        quotes: [],
        follow: [1],
      });
    const pieces = reply.match(/.{1,4}/gsu) ?? [];
    const sse = (e: Record<string, unknown>) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`;
    const annotations = search
      ? searchUrls.length
        ? searchUrls.map((url) => ({ type: "url_citation", start_index: 0, end_index: 3, url, title: url }))
        : [{ type: "url_citation", start_index: 0, end_index: 3, url: "https://bun.sh/", title: "Bun" }]
      : [];
    const messageItem = {
      type: "message",
      id: `msg_${randomToken(6)}`,
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: reply, annotations }],
    };

    const stream = new ReadableStream<string>({
      async start(c) {
        c.enqueue(sse({ type: "response.created", response: { id: "resp_mock" } }));
        if (search) {
          c.enqueue(sse({ type: "response.output_item.added", item: { type: "web_search_call", id: "ws_mock" } }));
          if (mode === "slow") await sleep(1500);
        }
        if (search)
          c.enqueue(
            sse({
              type: "response.output_item.done",
              item: {
                type: "web_search_call",
                id: "ws_mock",
                status: "completed",
                action: { type: "search", query: "bun" },
              },
            }),
          );
        for (let i = 0; i < pieces.length; i++) {
          if (mode === "slow") await sleep(100);
          c.enqueue(sse({ type: "response.output_text.delta", delta: pieces[i] }));
          if ((mode === "drop" || mode === "usage_limit" || mode === "incomplete") && i === 1) break;
        }
        if (reply && mode === "ok") c.enqueue(sse({ type: "response.output_item.done", item: messageItem }));
        if (call && mode === "ok")
          c.enqueue(
            sse({
              type: "response.output_item.done",
              item: {
                type: "function_call",
                id: `fc_${randomToken(6)}`,
                call_id: `call_${randomToken(6)}`,
                name: call.name,
                arguments: call.args,
                status: "completed",
              },
            }),
          );
        if (mode === "usage_limit")
          c.enqueue(
            sse({
              type: "response.failed",
              response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } },
            }),
          );
        else if (mode === "incomplete")
          c.enqueue(
            sse({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }),
          );
        else if (mode !== "drop")
          c.enqueue(sse({ type: "response.completed", response: { id: "resp_mock", status: "completed" } }));
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      switch (url.pathname) {
        case "/.well-known/openid-configuration":
          count("discovery");
          return json(200, {
            issuer: base,
            authorization_endpoint: `${base}/api/accounts/authorize`,
            token_endpoint: `${base}/api/accounts/oauth/token`,
            revocation_endpoint: `${base}/api/accounts/oauth/revoke`,
            jwks_uri: `${base}/.well-known/jwks.json`,
          });
        case "/.well-known/jwks.json":
          count("jwks");
          return json(200, { keys: [publicJwk] });
        case "/api/accounts/authorize":
          return authorize(url);
        case "/api/accounts/oauth/token":
          return token(req);
        case "/api/accounts/oauth/revoke":
          return revoke(req);
        case "/v1/models":
          count("models");
          if (!bearerOk(req)) return json(401, { detail: "token not accepted" });
          return json(200, {
            models: [
              { slug: "mock-chat", display_name: "Mock Chat", visibility: "list" },
              { slug: "mock-hidden", display_name: "Hidden", visibility: "hide" },
            ],
          });
        case "/v1/responses":
          return responses(req);
        case "/mock/mode": {
          const body = parseObject(await req.text()) ?? {};
          if (body.reset) mock.reset();
          else mock.setModes(body as Partial<MockModes>);
          return json(200, { modes });
        }
        case "/mock/stats":
          return json(200, stats);
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;

  const mock: MockSiwc = {
    url: base,
    get modes() {
      return modes;
    },
    stats,
    setModes(m) {
      modes = { ...modes, ...m };
    },
    reset() {
      modes = { ...DEFAULT_MODES };
      stats.counts = {};
      stats.lastAuthorize = null;
      stats.lastResponsesBody = null;
      stats.responsesBodies = [];
    },
    stop: () => server.stop(true),
  };
  return mock;
}

// "[tool:NAME {json}]" / "[say+tool:NAME {json}]" 표시를 찾는다. JSON 안의 "]" 때문에 정규식 대신 실제로 파싱되는 끝을 찾는다
function findToolMarker(text: string): { say: boolean; name: string; args: string } | null {
  for (const m of text.matchAll(/\[(say\+)?tool:([a-z_]+) /g)) {
    const start = (m.index ?? 0) + m[0].length;
    for (let end = text.indexOf("}]", start); end >= 0; end = text.indexOf("}]", end + 1)) {
      const candidate = text.slice(start, end + 1);
      try {
        JSON.parse(candidate);
        return { say: !!m[1], name: m[2] ?? "", args: candidate };
      } catch {}
    }
  }
  return null;
}
