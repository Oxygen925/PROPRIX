// 리서치 수집 규칙 (P11a, 사용자 결정 2026-10-30): http(s) 만, 로컬·사설망 주소는 늘 차단(DNS 로 풀어 IP 까지),
// 사용자 차단 도메인(하위 도메인 포함). 리다이렉트·페이지 안의 하위 요청도 같은 검사를 거친다
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: "scheme" | "private" | "denied" | "invalid" };

// IPv4·IPv6 가 로컬·사설·링크 로컬·멀티캐스트·예약 대역인가
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(ip) === 6) {
    const g = ipv6Groups(ip);
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = g;
    const v4At = (i: number) => {
      const hi = g[i] ?? 0;
      const lo = g[i + 1] ?? 0;
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    };
    const zeros = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
    if (zeros && g4 === 0 && g5 === 0xffff) return isPrivateIp(v4At(6)); // ::ffff:0:0/96 (IPv4 매핑)
    if (zeros && g4 === 0xffff && g5 === 0) return isPrivateIp(v4At(6)); // ::ffff:0:0:0/96 (SIIT)
    if (zeros && g4 === 0 && g5 === 0) return true; // ::, ::1, IPv4 호환
    if (g0 === 0x64 && g1 === 0xff9b) {
      if (g2 === 1) return true; // 64:ff9b:1::/48 (로컬 NAT64)
      if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIp(v4At(6)); // NAT64
    }
    if (g0 === 0x2002) return isPrivateIp(v4At(1)); // 6to4
    if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true; // Teredo, 문서용
    return (
      (g0 & 0xfe00) === 0xfc00 || // 고유 로컬
      (g0 & 0xffc0) === 0xfe80 || // 링크 로컬
      (g0 & 0xffc0) === 0xfec0 || // 사이트 로컬
      g0 >= 0xff00 // 멀티캐스트
    );
  }
  return true; // IP 가 아니면 (호출하는 쪽이 풀어서 넘긴다) 막는다
}

// IPv6 주소를 16비트 8묶음으로. new URL 은 ::ffff:127.0.0.1 을 ::ffff:7f00:1 로 바꾸므로 문자열로는 비교하지 않는다
function ipv6Groups(ip: string): number[] {
  let v = ip.split("%")[0] ?? "";
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
    v = `${v.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parse = (s: string | undefined) => (s ? s.split(":").map((h) => Number.parseInt(h, 16)) : []);
  const [head, tail] = v.split("::");
  const left = parse(head);
  const right = parse(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

export function domainMatches(host: string, deny: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return deny.some((d) => h === d || h.endsWith(`.${d}`));
}

// 주소 모양만 보는 검사 (DNS 없이): scheme, 차단 도메인, IP 리터럴·localhost
// 로그인 상태에서 따라가면 안 되는 링크 (로그아웃·탈퇴·삭제·결제 등): 주소와 링크 글로 걸러낸다
const UNSAFE_LINK =
  /log-?out|sign-?out|logoff|로그아웃|탈퇴|withdraw|deactivate|delete|remove|삭제|unsubscribe|구독\s*취소|checkout|payment|purchase|결제|구매/i;
export const unsafeLink = (url: string, text = ""): boolean => UNSAFE_LINK.test(url) || UNSAFE_LINK.test(text);

export function checkUrlShape(raw: string, deny: readonly string[]): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username || url.password) return { ok: false, reason: "invalid" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    return { ok: false, reason: "private" };
  if (isIP(host) && isPrivateIp(host)) return { ok: false, reason: "private" };
  if (domainMatches(host, deny)) return { ok: false, reason: "denied" };
  return { ok: true, url };
}

export type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

// 모양 검사 + DNS 로 푼 모든 IP 가 공인 주소인가 (DNS rebinding 은 브라우저가 실제로 붙는 IP 까지는 못 막지만,
// 하위 요청마다 다시 보므로 사설망으로 바뀐 이름은 다음 요청부터 막힌다)
export async function checkUrl(
  raw: string,
  deny: readonly string[],
  resolve: Resolver = systemResolver,
): Promise<UrlVerdict> {
  const shape = checkUrlShape(raw, deny);
  if (!shape.ok) return shape;
  const host = shape.url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return shape;
  try {
    const ips = await resolve(host);
    if (ips.length === 0 || ips.some(isPrivateIp)) return { ok: false, reason: "private" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
  return shape;
}
