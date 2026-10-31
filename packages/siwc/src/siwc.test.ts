// desktop_pet tests/unit/ai_tests.cpp 의 SIWC 케이스 대응 이식
import { describe, expect, test } from "bun:test";
import { findRsaJwk, parseJwt, validateIdTokenClaims, verifyRs256 } from "./jwt";
import {
  type AuthorizeParams,
  applyDiscovery,
  base64UrlDecode,
  base64UrlEncode,
  buildAuthorizeUrl,
  classifyErrorCode,
  classifyHttpError,
  classifyRefreshError,
  codeExchangeBody,
  discoveryUrl,
  endpointsForBase,
  hasPlanUsage,
  isProduction,
  needsRefresh,
  parseCallback,
  parseTokenResponse,
  pkceChallenge,
  productionEndpoints,
  redirectUri,
  refreshBody,
  revokeBody,
  urlEncode,
} from "./protocol";
import { buildResponsesRequest, citationsOf, interpretEvent, parseModels, SseParser } from "./responses";

const enc = (s: string) => base64UrlEncode(new TextEncoder().encode(s));
const query = (url: string) => new URLSearchParams(url.slice(url.indexOf("?") + 1));

test("base64url·URL 인코딩", () => {
  expect(enc("")).toBe("");
  expect(enc("f")).toBe("Zg");
  expect(enc("foob")).toBe("Zm9vYg");
  expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  expect([...(base64UrlDecode("-_8") ?? [])]).toEqual([0xfb, 0xff]);
  expect(base64UrlDecode("a")).toBeNull();
  expect(base64UrlDecode("ab$c")).toBeNull();
  expect(urlEncode("a b&c=d/é!*")).toBe("a%20b%26c%3Dd%2F%C3%A9%21%2A");
  // RFC 7636 부록 B
  expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

describe("인가 URL", () => {
  const base: AuthorizeParams = {
    clientId: "",
    agentName: "PROPRIX",
    hostId: "urn:uuid:1234",
    redirectUri: redirectUri(1455),
    state: "st",
    nonce: "no",
    codeChallenge: "ch",
    idTokenHint: "should-not-appear",
  };

  test("엔드포인트", () => {
    const ep = productionEndpoints();
    expect(ep.authorize).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(isProduction(ep)).toBe(true);
    expect(isProduction(endpointsForBase("http://127.0.0.1:5000/"))).toBe(false);
    expect(endpointsForBase("http://127.0.0.1:5000/").token).toBe("http://127.0.0.1:5000/api/accounts/oauth/token");
  });

  test("최초 등록", () => {
    const q = query(buildAuthorizeUrl(productionEndpoints(), base));
    expect(q.get("client_id")).toBe("dynamic_agent_client");
    expect(q.get("agent_name_hint")).toBe("PROPRIX");
    expect(q.get("ext_agent_host_id")).toBe("urn:uuid:1234");
    expect(q.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(q.get("scope")).toBe("openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
    expect(q.get("resource")).toBe("https://api.openai.com/v1");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.has("id_token_hint")).toBe(false);
  });

  test("다시 로그인", () => {
    const q = query(buildAuthorizeUrl(productionEndpoints(), { ...base, clientId: "oaiapp_abc", loginHint: "a@b.c" }));
    expect(q.get("client_id")).toBe("oaiapp_abc");
    expect(q.has("agent_name_hint")).toBe(false);
    expect(q.get("id_token_hint")).toBe("should-not-appear");
    expect(q.get("login_hint")).toBe("a@b.c");
  });

  test("재동의는 다시 로그인에만", () => {
    const again = query(buildAuthorizeUrl(productionEndpoints(), { ...base, clientId: "oaiapp_1", reconsent: true }));
    expect(again.get("prompt")).toBe("consent");
    expect(buildAuthorizeUrl(productionEndpoints(), { ...base, reconsent: true })).not.toContain("prompt=");
  });
});

test("discovery", () => {
  const ep = endpointsForBase("http://127.0.0.1:5000");
  expect(discoveryUrl(ep)).toBe("http://127.0.0.1:5000/.well-known/openid-configuration");
  const d = {
    issuer: "http://127.0.0.1:5000",
    authorization_endpoint: "http://127.0.0.1:5000/a",
    token_endpoint: "http://127.0.0.1:5000/t",
    revocation_endpoint: "http://127.0.0.1:5000/r",
    jwks_uri: "http://127.0.0.1:5000/k",
  };
  const next = applyDiscovery(ep, JSON.stringify(d));
  expect(typeof next).toBe("object");
  if (typeof next === "object") {
    expect(next.revoke).toBe("http://127.0.0.1:5000/r");
    expect(next.api).toBe("http://127.0.0.1:5000/v1"); // API 주소는 discovery 대상 아님
  }
  const evil = { ...d, issuer: "https://auth.openai.com", token_endpoint: "https://evil.example/t" };
  expect(typeof applyDiscovery(productionEndpoints(), JSON.stringify(evil))).toBe("string"); // 다른 origin
  expect(typeof applyDiscovery(productionEndpoints(), JSON.stringify(d))).toBe("string"); // issuer 불일치
  expect(typeof applyDiscovery(ep, "not json")).toBe("string");
});

test("콜백은 state 를 먼저 검증", () => {
  expect(parseCallback("code=c&state=bad&client_id=oaiapp_1", "good", "").kind).toBe("invalid");
  expect(parseCallback("error=access_denied&state=bad", "good", "").kind).toBe("invalid");
  expect(parseCallback("error=access_denied&state=good", "good", "").kind).toBe("denied");
  expect(parseCallback("code=c&state=good", "good", "").kind).toBe("invalid");
  expect(parseCallback("code=c&state=good&client_id=dynamic_agent_client", "good", "").kind).toBe("invalid");
  expect(parseCallback("code=c&state=good&client_id=oaiapp_1&scope=openid", "good", "")).toEqual({
    kind: "code",
    code: "c",
    clientId: "oaiapp_1",
    scope: "openid",
  });
  const re = parseCallback("code=c&state=good", "good", "oaiapp_9");
  expect(re.kind === "code" && re.clientId).toBe("oaiapp_9");
  expect(parseCallback("code=c&state=good&client_id=oaiapp_other", "good", "oaiapp_9").kind).toBe("invalid");
  expect(parseCallback("state=good&client_id=oaiapp_1", "good", "").kind).toBe("invalid");
  expect(parseCallback("code=c&state=", "", "").kind).toBe("invalid");
});

test("토큰 본문과 응답", () => {
  const f = new URLSearchParams(codeExchangeBody("oaiapp_1", "c0de", "ver", "http://127.0.0.1:1455/auth/callback"));
  expect(f.get("grant_type")).toBe("authorization_code");
  expect(f.get("code_verifier")).toBe("ver");
  expect(f.get("resource")).toBe("https://api.openai.com/v1");
  const rf = new URLSearchParams(refreshBody("oaiapp_1", "rt"));
  expect(rf.get("grant_type")).toBe("refresh_token");
  expect(rf.has("scope")).toBe(false);
  const rv = new URLSearchParams(revokeBody("oaiapp_1", "rt"));
  expect(rv.get("token_type_hint")).toBe("refresh_token");
  expect(rv.get("token")).toBe("rt");

  const t = parseTokenResponse(
    200,
    JSON.stringify({
      access_token: "a",
      refresh_token: "r",
      id_token: "i",
      expires_in: 3600,
      scope: "openid email chatgpt.tokens.use.direct",
    }),
    1000,
  );
  if (!t.ok) throw new Error("expected ok");
  expect(t.tokens.expiresAt).toBe(4600);
  expect(hasPlanUsage(t.tokens)).toBe(true);
  expect(needsRefresh(t.tokens, 4000)).toBe(false);
  expect(needsRefresh(t.tokens, 4500)).toBe(true);
  const r = parseTokenResponse(
    200,
    JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 60 }),
    2000,
    t.tokens,
  );
  if (!r.ok) throw new Error("expected ok");
  expect(r.tokens.idToken).toBe("i");
  expect(r.tokens.refreshToken).toBe("r2");
  expect(hasPlanUsage(r.tokens)).toBe(true);
  const noPlan = parseTokenResponse(200, JSON.stringify({ access_token: "a", scope: "openid profile email" }), 0);
  expect(noPlan.ok && hasPlanUsage(noPlan.tokens)).toBe(false);
  expect(parseTokenResponse(400, JSON.stringify({ error: "invalid_grant" }), 0)).toMatchObject({
    error: "invalid_grant",
  });
  expect(parseTokenResponse(503, "oops", 0)).toMatchObject({ error: "http_503" });
  expect(parseTokenResponse(200, "{}", 0)).toMatchObject({ error: "invalid_response" });
});

describe("ID 토큰", () => {
  const h = { alg: "RS256", kid: "k1" };
  const p = {
    iss: "https://auth.openai.com",
    aud: "oaiapp_1",
    exp: 2000,
    iat: 900,
    nonce: "n1",
    sub: "user-1",
    email: "a@b.c",
  };
  const make = (hh: object, pp: object) => `${enc(JSON.stringify(hh))}.${enc(JSON.stringify(pp))}.${enc("sig")}`;
  const check = (hh: object, pp: object, now = 1000, nonce = "n1") => {
    const jwt = parseJwt(make(hh, pp));
    if (!jwt) throw new Error("parse failed");
    return validateIdTokenClaims(jwt, "https://auth.openai.com", "oaiapp_1", nonce, now);
  };
  const ok = (v: unknown) => typeof v === "object";

  test("클레임 검증", () => {
    expect(check(h, p)).toEqual({ subject: "user-1", email: "a@b.c" });
    expect(ok(check({ alg: "none" }, p))).toBe(false);
    expect(ok(check(h, { ...p, iss: "https://evil" }))).toBe(false);
    expect(ok(check(h, { ...p, aud: "oaiapp_2" }))).toBe(false);
    expect(ok(check(h, { ...p, aud: ["x", "oaiapp_1"] }))).toBe(true);
    expect(ok(check(h, { ...p, nonce: "n2" }))).toBe(false);
    expect(ok(check(h, p, 2000 + 59))).toBe(true);
    expect(ok(check(h, p, 2000 + 61))).toBe(false);
    expect(ok(check(h, { ...p, iat: 1100 }))).toBe(false);
    const { iat: _iat, ...noIat } = p;
    expect(ok(check(h, noIat))).toBe(false);
    expect(ok(check(h, { ...p, azp: "oaiapp_1" }))).toBe(true);
    expect(ok(check(h, { ...p, azp: "oaiapp_2" }))).toBe(false);
    expect(ok(check(h, { ...p, nonce: "other" }, 1000, ""))).toBe(true); // 갱신: nonce 생략
    expect(ok(check(h, { ...p, sub: "" }))).toBe(false);
    expect(parseJwt("a.b")).toBeNull();
    expect(parseJwt("a.b.c.d")).toBeNull();
  });

  test("JWKS 선택", () => {
    const jwks = JSON.stringify({
      keys: [
        { kty: "EC", kid: "k1" },
        { kty: "RSA", kid: "k1", use: "sig", n: "AQAB", e: "AQAB" },
      ],
    });
    expect(findRsaJwk(jwks, "k1")).toEqual({ kty: "RSA", n: "AQAB", e: "AQAB" });
    expect(findRsaJwk(JSON.stringify({ keys: [{ kty: "RSA", kid: "k2", n: "AQAB", e: "AQAB" }] }), "k1")).toBeNull();
  });

  test("RS256 서명 왕복과 변조 거부", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const input = make(h, p).split(".").slice(0, 2).join(".");
    const sig = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input)),
    );
    const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
    expect(await verifyRs256(pub, input, sig)).toBe(true);
    expect(await verifyRs256(pub, `${input}x`, sig)).toBe(false);
  });
});

test("오류 분류표", () => {
  expect(classifyErrorCode("subscription_sharing_user_not_eligible", 403)).toBe("not_eligible");
  expect(classifyErrorCode("subscription_sharing_usage_limit_exceeded", 0)).toBe("usage_limit");
  expect(classifyErrorCode("subscription_sharing_usage_unavailable", 503)).toBe("retry_backoff");
  expect(classifyErrorCode("subscription_sharing_user_unavailable", 503)).toBe("retry_backoff");
  expect(classifyErrorCode("subscription_sharing_unsupported_capability", 400)).toBe("fix_request");
  expect(classifyErrorCode("subscription_sharing_route_not_supported", 403)).toBe("fix_request");
  expect(classifyErrorCode("subscription_sharing_invalid_user", 401)).toBe("re_sign_in");
  expect(classifyErrorCode("chatpass_v2_scope_not_authorized", 403)).toBe("client_config");
  expect(classifyErrorCode("", 401)).toBe("re_sign_in");
  expect(classifyErrorCode("", 403)).toBe("restricted");
  expect(classifyErrorCode("", 503)).toBe("retry_backoff");
  const e = classifyHttpError(
    400,
    JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", param: "temperature" } }),
  );
  expect(e.param).toBe("temperature");
  expect(e.recovery).toBe("fix_request");
  const d = classifyHttpError(403, JSON.stringify({ detail: "region" }));
  expect(d).toMatchObject({ code: "", message: "region", recovery: "restricted" });
  expect(classifyHttpError(500, JSON.stringify({ error: null })).recovery).toBe("retry_backoff"); // 타입이 틀려도 던지지 않음
  expect(classifyRefreshError("invalid_grant", 400)).toBe("re_sign_in");
  expect(classifyRefreshError("refresh_token_reused", 400)).toBe("re_sign_in");
  expect(classifyRefreshError("invalid_client", 401)).toBe("client_config");
  expect(classifyRefreshError("", 503)).toBe("retry_backoff");
  expect(classifyRefreshError("", 0)).toBe("retry_backoff");
});

test("SSE 파서는 어떻게 잘려도 같은 결과", () => {
  const stream =
    ': comment\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"안녕"}\r\n\r\n' +
    "event: x\ndata: line1\ndata: line2\n\n" +
    'data: {"type":"response.completed"}\r\r';
  for (const step of [1, 2, 3, 7, stream.length]) {
    const p = new SseParser();
    const ev = [];
    for (let i = 0; i < stream.length; i += step) ev.push(...p.feed(stream.slice(i, i + step)));
    expect(ev.length).toBe(3);
    expect(ev[0]?.event).toBe("response.output_text.delta");
    expect(ev[1]?.data).toBe("line1\nline2");
    expect(interpretEvent(ev[0] ?? { event: "", data: "" })).toEqual({ kind: "delta", text: "안녕" });
    expect(interpretEvent(ev[2] ?? { event: "", data: "" }).kind).toBe("completed");
  }
  const p = new SseParser();
  expect([...p.feed("data: unterminated"), ...p.finish()]).toEqual([]);
});

test("스트림 이벤트 해석", () => {
  const ev = (data: string, event = "") => interpretEvent({ event, data });
  expect(
    ev(
      JSON.stringify({
        type: "response.failed",
        response: { error: { code: "subscription_sharing_usage_limit_exceeded" } },
      }),
    ),
  ).toMatchObject({ kind: "failed", code: "subscription_sharing_usage_limit_exceeded" });
  expect(
    ev(
      JSON.stringify({
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      }),
    ),
  ).toEqual({ kind: "incomplete", reason: "max_output_tokens" });
  expect(ev(JSON.stringify({ type: "error", code: "x", message: "m" }), "error")).toMatchObject({ code: "x" });
  expect(ev("not json").kind).toBe("ignore");
  expect(ev("[DONE]").kind).toBe("ignore");
  expect(ev(JSON.stringify({ type: "response.created" })).kind).toBe("ignore");
  expect(ev(JSON.stringify({ type: "response.failed", response: { error: "bad" } }))).toMatchObject({ code: "" });
});

test("Responses 요청과 모델 목록", () => {
  const body = JSON.parse(
    buildResponsesRequest({
      model: "m1",
      instructions: "be nice",
      turns: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "yo" },
        { role: "user", text: "q\uD800" },
      ],
    }),
  );
  expect(body).toMatchObject({ store: false, stream: true, model: "m1", instructions: "be nice" });
  expect(body.input.length).toBe(3);
  expect(body.input[1].role).toBe("assistant");
  expect(body.input[2].content).toBe("q�"); // 짝 없는 서로게이트 → U+FFFD
  for (const banned of ["max_output_tokens", "temperature", "previous_response_id", "user", "metadata", "reasoning"])
    expect(banned in body).toBe(false);
  const m = parseModels(
    JSON.stringify({
      models: [
        {
          slug: "a",
          display_name: "A",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        },
        { slug: "b", visibility: "hide" },
        { slug: "c", visibility: "list", supported_reasoning_levels: ["medium"] },
      ],
    }),
  );
  expect(m).toEqual([
    { slug: "a", displayName: "A", efforts: ["low", "high"] },
    { slug: "c", displayName: "c", efforts: ["medium"] },
  ]);
  expect(parseModels("{}")).toEqual([]);
});

test("도구가 있으면 tools·parallel_tool_calls:false·include 를 붙이고, items 를 turns 뒤에 잇는다", () => {
  const body = JSON.parse(
    buildResponsesRequest({
      model: "m",
      instructions: "",
      turns: [{ role: "user", text: "q" }],
      items: [{ type: "function_call_output", call_id: "c1", output: "{}" }],
      tools: [{ type: "web_search" }],
    }),
  );
  expect(body.input.map((i: { type?: string; role?: string }) => i.type ?? i.role)).toEqual([
    "user",
    "function_call_output",
  ]);
  expect(body).toMatchObject({
    parallel_tool_calls: false,
    include: ["reasoning.encrypted_content"],
    tools: [{ type: "web_search" }],
  });
  const plain = JSON.parse(buildResponsesRequest({ model: "m", instructions: "", turns: [] }));
  for (const k of ["tools", "include", "parallel_tool_calls"]) expect(k in plain).toBe(false);
});

test("output_item.done 은 항목으로, url_citation 은 http(s) 출처로", () => {
  expect(
    interpretEvent({
      event: "",
      data: JSON.stringify({ type: "response.output_item.done", item: { type: "function_call" } }),
    }),
  ).toEqual({
    kind: "item",
    item: { type: "function_call" },
  });
  const msg = (url: string) => ({
    type: "message",
    content: [{ type: "output_text", annotations: [{ type: "url_citation", url, title: "" }] }],
  });
  expect(
    citationsOf([
      msg("https://a.test/"),
      msg("https://a.test/"),
      msg("file:///etc/passwd"),
      { type: "message", content: "x" },
    ]),
  ).toEqual([{ url: "https://a.test/", title: "https://a.test/" }]);
});

test("내장 웹 검색 시작 이벤트를 알아본다 (다른 항목 추가는 무시)", () => {
  const ev = (data: object) => ({ event: "", data: JSON.stringify(data) });
  expect(interpretEvent(ev({ type: "response.output_item.added", item: { type: "web_search_call" } }))).toEqual({
    kind: "searching",
  });
  expect(interpretEvent(ev({ type: "response.web_search_call.searching" }))).toEqual({ kind: "searching" });
  expect(interpretEvent(ev({ type: "response.output_item.added", item: { type: "message" } }))).toEqual({
    kind: "ignore",
  });
});
