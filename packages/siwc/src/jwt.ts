// ID 토큰(JWT, RS256) 파싱·서명 검증·클레임 검증.
import type { webcrypto } from "node:crypto";
import { base64UrlDecode, isObject, type JsonObject, str } from "./protocol";

type JsonWebKey = webcrypto.JsonWebKey;

export interface Jwt {
  header: JsonObject;
  payload: JsonObject;
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
}

export interface Identity {
  subject: string;
  email: string;
}

function decodeJsonPart(part: string): JsonObject | null {
  const bytes = base64UrlDecode(part);
  if (!bytes) return null;
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

export function parseJwt(token: string): Jwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJsonPart(h);
  const payload = decodeJsonPart(p);
  const signature = base64UrlDecode(s);
  if (!header || !payload || !signature) return null;
  return { header, payload, signingInput: `${h}.${p}`, signature };
}

// 성공하면 Identity, 실패하면 사유. nonce 가 비면 확인하지 않는다 (갱신 응답의 ID 토큰)
export function validateIdTokenClaims(
  jwt: Jwt,
  issuer: string,
  audience: string,
  nonce: string,
  nowUnix: number,
  leewaySec = 60,
): Identity | string {
  const { header: h, payload: p } = jwt;
  if (str(h, "alg") !== "RS256") return "alg 가 RS256 이 아님";
  if (str(p, "iss") !== issuer) return "iss 불일치";
  const aud = p.aud;
  const audOk = aud === audience || (Array.isArray(aud) && aud.includes(audience));
  if (!audOk) return "aud 불일치";
  if ("azp" in p && p.azp !== audience) return "azp 불일치";
  if (typeof p.exp !== "number") return "exp 없음";
  if (typeof p.iat !== "number") return "iat 없음";
  if (p.exp + leewaySec < nowUnix) return "만료된 ID 토큰";
  if (p.iat - leewaySec > nowUnix) return "iat 가 미래";
  if (nonce && str(p, "nonce") !== nonce) return "nonce 불일치";
  const subject = str(p, "sub");
  if (!subject) return "sub 없음";
  return { subject, email: str(p, "email") };
}

export function findRsaJwk(jwksJson: string, kid: string): JsonWebKey | null {
  let j: unknown;
  try {
    j = JSON.parse(jwksJson);
  } catch {
    return null;
  }
  if (!isObject(j) || !Array.isArray(j.keys)) return null;
  for (const k of j.keys) {
    if (!isObject(k) || str(k, "kty") !== "RSA") continue;
    if (kid && str(k, "kid") !== kid) continue;
    if ("use" in k && str(k, "use") !== "sig") continue;
    const n = str(k, "n");
    const e = str(k, "e");
    if (!base64UrlDecode(n)?.length || !base64UrlDecode(e)?.length) continue;
    return { kty: "RSA", n, e };
  }
  return null;
}

export async function verifyRs256(
  jwk: JsonWebKey,
  signingInput: string,
  signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(signingInput));
  } catch {
    return false;
  }
}
