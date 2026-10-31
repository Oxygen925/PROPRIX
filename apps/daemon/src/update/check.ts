// 새 버전 알림: GitHub Releases 의 최신 버전과 비교만 한다. 내려받기·설치는 사용자가 직접 한다.
// 화면이 물어볼 때만 요청하고 결과는 하루(실패는 1시간) 보관한다. 저장소가 비공개이거나 실패하면 알리지 않는다
import { z } from "zod";

const LATEST_URL = "https://api.github.com/repos/Oxygen925/PROPRIX/releases/latest";
const TTL_MS = 24 * 60 * 60_000;
const FAILED_TTL_MS = 60 * 60_000;
const Release = z.object({ tag_name: z.string() });

const parse = (v: string) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

export class UpdateChecker {
  private cached: { latest: string | null; at: number; ttl: number } | null = null;
  private inflight: Promise<string | null> | null = null;

  constructor(
    private readonly current: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** 지금보다 새 버전이 있으면 그 버전 (앞의 v 없이), 없거나 모르면 null */
  latest(): Promise<string | null> {
    if (this.cached && this.now() - this.cached.at <= this.cached.ttl) return Promise.resolve(this.cached.latest);
    this.inflight ??= this.fetchLatest().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchLatest(): Promise<string | null> {
    let latest: string | null = null;
    let ttl = FAILED_TTL_MS;
    try {
      const res = await this.fetcher(LATEST_URL, {
        headers: { accept: "application/vnd.github+json", "user-agent": `PROPRIX/${this.current}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const tag = Release.parse(await res.json()).tag_name;
        if (isNewer(tag, this.current)) latest = tag.trim().replace(/^v/, "");
        ttl = TTL_MS;
      }
    } catch (err) {
      console.warn("[update] 새 버전 확인 실패", err);
    }
    this.cached = { latest, at: this.now(), ttl };
    return latest;
  }
}
