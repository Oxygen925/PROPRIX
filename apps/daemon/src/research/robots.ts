// robots.txt (P11a): 우리 User-agent(PROPRIX-Research) 묶음, 없으면 '*' 묶음의 Allow·Disallow 를 따른다.
// 가장 긴 규칙이 이기고 길이가 같으면 Allow. 받지 못하면 RFC 9309 대로 4xx 는 허용, 5xx·429·네트워크 오류는 거부한다
// (사용자 결정 2026-11-01). 호스트(origin)별로 1시간, 거부는 복구되면 다시 확인하도록 5분 캐시
import { RESEARCH_USER_AGENT } from "@proprix/shared";
import { checkUrl, type UrlVerdict } from "./policy";

interface Rule {
  allow: boolean;
  path: string;
}

export function parseRobots(text: string, agent = RESEARCH_USER_AGENT): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" || key === "disallow") {
      // 빈 Disallow 는 모두 허용 (규칙 없음)
      if (value === "" && key === "disallow") continue;
      cur.rules.push({ allow: key === "allow", path: value });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.toLowerCase().includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

// 규칙의 * (아무 글자)와 끝의 $ (끝) 를 정규식으로
function ruleRegex(path: string): RegExp {
  const anchored = path.endsWith("$");
  const body = (anchored ? path.slice(0, -1) : path).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function robotsAllows(rules: readonly Rule[], pathAndQuery: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!ruleRegex(r.path).test(pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

const TTL_MS = 60 * 60_000;
const FAILED_TTL_MS = 5 * 60_000;
const DENY_ALL: Rule[] = [{ allow: false, path: "/" }];
const MAX_BYTES = 500_000;

const MAX_REDIRECTS = 5;

// robots.txt 를 받는다. 공개 사이트가 내부 주소로 보내지 못하게 리다이렉트마다 주소를 검사한다
export async function fetchRobots(
  url: string,
  raw: typeof fetch = fetch,
  check: (url: string) => Promise<UrlVerdict> = (u) => checkUrl(u, []),
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await raw(current, {
      headers: { "user-agent": RESEARCH_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    current = new URL(location, current).href;
    const verdict = await check(current);
    if (!verdict.ok) throw new Error(`robots.txt 리다이렉트 거부: ${verdict.reason}`);
  }
  throw new Error("robots.txt 리다이렉트가 너무 많습니다");
}

export class RobotsCache {
  private readonly cache = new Map<string, { rules: Rule[]; at: number; ttl: number }>();

  constructor(
    private readonly fetcher: (url: string) => Promise<Response> = (url) => fetchRobots(url),
    private readonly now: () => number = Date.now,
  ) {}

  async allows(url: URL): Promise<boolean> {
    const origin = url.origin;
    let entry = this.cache.get(origin);
    if (!entry || this.now() - entry.at > entry.ttl) {
      const rules = await this.load(origin);
      entry = { rules, at: this.now(), ttl: rules === DENY_ALL ? FAILED_TTL_MS : TTL_MS };
      this.cache.set(origin, entry);
    }
    return robotsAllows(entry.rules, url.pathname + url.search);
  }

  private async load(origin: string): Promise<Rule[]> {
    try {
      const res = await this.fetcher(`${origin}/robots.txt`);
      if (res.status >= 500 || res.status === 429) return DENY_ALL;
      if (!res.ok) return [];
      const text = (await res.text()).slice(0, MAX_BYTES);
      return parseRobots(text);
    } catch {
      return DENY_ALL;
    }
  }
}
