// 리서치 페이지 읽기 (P11a): 주소 검사 → robots.txt → 도메인 간격 → 새 context 에서 렌더링 → 본문 추출.
// - 페이지마다 새 browser context (쿠키·저장소를 남기지 않음), 다운로드 거부, 창 열기 막음
// - 하위 요청도 주소 검사 (사설망·차단 도메인), 이미지·미디어·글꼴은 받지 않음 (속도)
// - 20초 제한, 동시 2개, 같은 도메인 2초 간격, 5분 쉬면 브라우저를 닫는다
// - 봇 차단·CAPTCHA 로 보이면 blocked 로 건너뛴다 (우회하지 않음 — 사용자 결정 2026-10-30)
// - 계정을 등록한 사이트만 에이전트 전용 context 에서 읽는다 (P12c): 쿠키가 에이전트끼리 분리되고, 다른 도메인에는 쓰지 않는다
import { RESEARCH_USER_AGENT, type SiteAccount, type SiteAccountOutcome } from "@proprix/shared";
import type { SiteAccountStore } from "./accounts";
import { Chromium } from "./cdp";
import { type Extracted, extractExpression } from "./extract";
import { HAS_PASSWORD, type PageHandle as LoginPage, performLogin } from "./login";
import { checkUrl, checkUrlShape, domainMatches, type Resolver, type UrlVerdict, unsafeLink } from "./policy";
import { RobotsCache } from "./robots";

export type PageStatus = "ok" | "blocked" | "robots" | "denied" | "error" | "timeout";

export interface PageResult extends Extracted {
  url: string;
  finalUrl: string;
  status: PageStatus;
  httpStatus: number;
  reason: string;
  hasPassword?: boolean; // 비밀번호 칸이 보임 (로그인 벽 판단)
  session?: boolean; // 로그인 세션으로 읽음
}

// 누가 왜 읽는가 (P12c): 그 에이전트의 사이트 계정을 쓴다
export interface ReadContext {
  agentId: string;
  runKey: string; // 로그인은 실행당 한 번만
  onLogin?: (text: string) => void; // 행동 로그 (비밀번호 없음)
}

type PageHandle = LoginPage & { readonly httpStatus: number };
interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expires: number;
  session: boolean;
}

export interface PageReaderOptions {
  exePath: () => string | null;
  profileRoot: string; // 임시 프로필을 만들 폴더
  denyDomains: () => readonly string[];
  accounts?: SiteAccountStore;
  loginWaitMs?: number;
  robots?: RobotsCache;
  resolve?: Resolver;
  allowPrivate?: boolean; // 테스트 전용: 로컬 시험 사이트
  delayMs?: number;
  timeoutMs?: number;
  idleMs?: number;
  concurrency?: number;
}

// 실제 브라우저처럼 보이되 리서치 봇임을 밝힌다
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 ${RESEARCH_USER_AGENT}`;
const BLOCKED_TEXT =
  /captcha|verify you are (a )?human|unusual traffic|are you a robot|access denied|attention required/i;
const SKIP_TYPES = new Set(["Image", "Media", "Font"]);

const empty = (url: string, status: PageStatus, reason: string, httpStatus = 0): PageResult => ({
  url,
  finalUrl: url,
  status,
  httpStatus,
  reason,
  title: "",
  byline: "",
  published: "",
  text: "",
  links: [],
});

export class PageReader {
  private browser: Chromium | null = null;
  private starting: Promise<Chromium> | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly lastHit = new Map<string, number>();
  private readonly robots: RobotsCache;
  private ctxBrowser: Chromium | null = null;
  private readonly agentContexts = new Map<string, string>(); // agentId → browser context
  private readonly triedLogin = new Set<string>();

  constructor(private readonly opt: PageReaderOptions) {
    this.robots = opt.robots ?? new RobotsCache();
  }

  get available(): boolean {
    return this.opt.exePath() !== null;
  }

  private async verdict(url: string): Promise<UrlVerdict> {
    const deny = this.opt.denyDomains();
    if (this.opt.allowPrivate) {
      const v = checkUrlShape(url, deny);
      return v.ok || v.reason !== "private" ? v : { ok: true, url: new URL(url) };
    }
    return checkUrl(url, deny, this.opt.resolve);
  }

  async read(url: string, signal?: AbortSignal, ctx?: ReadContext): Promise<PageResult> {
    const v = await this.verdict(url);
    if (!v.ok) return empty(url, "denied", v.reason);
    if (!(await this.robots.allows(v.url))) return empty(url, "robots", "robots.txt");
    const account = ctx ? (this.opt.accounts?.match(ctx.agentId, v.url.hostname) ?? null) : null;
    if (account && unsafeLink(url)) return empty(url, "denied", "unsafe_link");
    await this.slot();
    try {
      await this.politeWait(v.url.host, signal);
      if (signal?.aborted) return empty(url, "error", "cancelled");
      if (account && ctx) return await this.readSession(v.url.href, account, ctx, signal);
      return await this.render(v.url.href, signal);
    } catch (err) {
      return empty(url, "error", err instanceof Error ? err.message : String(err));
    } finally {
      this.release();
    }
  }

  async close() {
    clearTimeout(this.idle);
    const b = this.browser;
    this.browser = null;
    await b?.close();
  }

  // ---- 동시성·간격 ----

  private async slot() {
    if (this.active < (this.opt.concurrency ?? 2)) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
    if (this.active === 0) {
      clearTimeout(this.idle);
      this.idle = setTimeout(() => void this.close(), this.opt.idleMs ?? 5 * 60_000);
    }
  }

  private async politeWait(host: string, signal?: AbortSignal) {
    const gap = this.opt.delayMs ?? 2000;
    const last = this.lastHit.get(host) ?? 0;
    const wait = last + gap - Date.now();
    this.lastHit.set(host, Math.max(Date.now(), last + gap));
    if (wait > 0 && !signal?.aborted) await Bun.sleep(wait);
  }

  private async ensure(): Promise<Chromium> {
    clearTimeout(this.idle);
    if (this.browser?.alive) return this.browser;
    if (!this.starting) {
      const exe = this.opt.exePath();
      if (!exe) throw new Error("리서치 브라우저가 설치돼 있지 않습니다");
      this.starting = Chromium.launch(exe, this.opt.profileRoot).finally(() => {
        this.starting = null;
      });
    }
    this.browser = await this.starting;
    return this.browser;
  }

  // ---- 로그인 세션 (P12c) ----

  // 에이전트 전용 context: 쿠키·저장소가 다른 에이전트와 분리된다. 저장해 둔 로그인 쿠키를 복원한다
  private async agentContext(b: Chromium, agentId: string): Promise<string> {
    if (this.ctxBrowser !== b) {
      this.ctxBrowser = b;
      this.agentContexts.clear();
      this.triedLogin.clear();
    }
    const known = this.agentContexts.get(agentId);
    if (known) return known;
    const { browserContextId } = await b.cdp.send<{ browserContextId: string }>("Target.createBrowserContext", {
      disposeOnDetach: true,
    });
    this.agentContexts.set(agentId, browserContextId);
    const cookies = (this.opt.accounts?.list(agentId) ?? []).flatMap((a) => this.opt.accounts?.session(a.id) ?? []);
    if (cookies.length) await b.cdp.send("Storage.setCookies", { cookies, browserContextId }).catch(() => {});
    return browserContextId;
  }

  private async saveCookies(b: Chromium, contextId: string, account: SiteAccount) {
    const r = await b.cdp.send<{ cookies: Cookie[] }>("Storage.getCookies", { browserContextId: contextId });
    const mine = r.cookies.filter((c) => {
      const d = c.domain.replace(/^\./, "");
      return domainMatches(d, [account.domain]) || domainMatches(account.domain, [d]);
    });
    this.opt.accounts?.saveSession(
      account.id,
      mine.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        ...(c.session ? {} : { expires: c.expires }),
      })),
    );
  }

  private async loginIn(
    b: Chromium,
    contextId: string,
    account: SiteAccount,
    signal?: AbortSignal,
  ): Promise<SiteAccountOutcome> {
    const accounts = this.opt.accounts;
    if (!accounts) return "error";
    const password = accounts.password(account.id);
    const outcome: SiteAccountOutcome = password
      ? await this.withPage<SiteAccountOutcome>(b, contextId, {}, (p) =>
          performLogin(p, account, password, {
            allowHttp: this.opt.allowPrivate,
            signal,
            waitMs: this.opt.loginWaitMs,
          }),
        ).catch(() => "error")
      : "no_password";
    if (outcome === "ok") await this.saveCookies(b, contextId, account);
    accounts.record(account.id, outcome);
    return outcome;
  }

  private async readSession(
    url: string,
    account: SiteAccount,
    ctx: ReadContext,
    signal?: AbortSignal,
  ): Promise<PageResult> {
    const b = await this.ensure();
    const contextId = await this.agentContext(b, account.agentId);
    const read = () => this.withPage(b, contextId, { readOnly: true }, (p) => this.readPage(p, url, signal));
    let r = await read();
    const accounts = this.opt.accounts as SiteAccountStore;
    const wall = () => r.httpStatus === 401 || !!r.hasPassword;
    if (wall()) {
      const key = `${ctx.runKey}:${account.id}`;
      if (!accounts.canAutoLogin(account))
        ctx.onLogin?.(
          `${account.domain}: 자동 로그인을 멈춘 상태입니다. 에이전트 편집기에서 '로그인 시험'을 눌러 주세요`,
        );
      else if (!this.triedLogin.has(key)) {
        this.triedLogin.add(key); // 실행당 한 번만
        ctx.onLogin?.(`로그인 중: ${account.domain}`);
        const outcome = await this.loginIn(b, contextId, account, signal);
        ctx.onLogin?.(
          outcome === "ok" ? `로그인 성공: ${account.domain}` : `로그인 실패: ${account.domain} (${outcome})`,
        );
        if (outcome === "ok") r = await read();
      }
    }
    if (r.status === "ok" && !wall()) await this.saveCookies(b, contextId, account).catch(() => {});
    // 로그인 벽만 있는 페이지를 글감으로 쓰지 않는다
    if (wall() && r.text.length < 1500) return { ...r, status: "blocked", reason: "login_required", session: true };
    return { ...r, session: true };
  }

  /** 계정을 고치거나 지웠을 때: 메모리에 남은 그 에이전트의 로그인 상태를 버린다 */
  async forgetAgent(agentId: string) {
    const id = this.agentContexts.get(agentId);
    this.agentContexts.delete(agentId);
    if (id && this.ctxBrowser?.alive)
      await this.ctxBrowser.cdp.send("Target.disposeBrowserContext", { browserContextId: id }).catch(() => {});
  }

  /** '로그인 시험': 지난 실패와 관계없이 새 context 에서 한 번 시도하고, 성공하면 쿠키를 저장한다 */
  async testLogin(account: SiteAccount): Promise<SiteAccountOutcome> {
    await this.slot();
    try {
      const b = await this.ensure();
      const { browserContextId } = await b.cdp.send<{ browserContextId: string }>("Target.createBrowserContext", {
        disposeOnDetach: true,
      });
      try {
        const outcome = await this.loginIn(b, browserContextId, account);
        if (outcome === "ok" && this.ctxBrowser === b) {
          const old = this.agentContexts.get(account.agentId);
          this.agentContexts.delete(account.agentId); // 다음 읽기에서 새 쿠키로 복원
          if (old) await b.cdp.send("Target.disposeBrowserContext", { browserContextId: old }).catch(() => {});
        }
        return outcome;
      } finally {
        await b.cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
      }
    } finally {
      this.release();
    }
  }

  // ---- 렌더링 ----

  private async render(url: string, signal?: AbortSignal): Promise<PageResult> {
    const b = await this.ensure();
    const { browserContextId } = await b.cdp.send<{ browserContextId: string }>("Target.createBrowserContext", {
      disposeOnDetach: true,
    });
    try {
      return await this.withPage(b, browserContextId, {}, (p) => this.readPage(p, url, signal));
    } finally {
      await b.cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    }
  }

  // 새 탭 하나를 열어 요청 검사를 걸고 fn 을 돌린 뒤 닫는다
  private async withPage<T>(
    b: Chromium,
    browserContextId: string,
    opt: { readOnly?: boolean },
    fn: (p: PageHandle) => Promise<T>,
  ): Promise<T> {
    const cdp = b.cdp;
    let session = "";
    let httpStatus = 0;
    let mainFrame = "";
    let loaded = false;
    const hostChecks = new Map<string, Promise<boolean>>();
    const allowed = (u: string) => {
      if (/^(data|blob|about):/.test(u)) return Promise.resolve(true);
      let host = "";
      try {
        host = new URL(u).host;
      } catch {
        return Promise.resolve(false);
      }
      let p = hostChecks.get(host);
      if (!p) {
        p = this.verdict(u).then((v) => v.ok);
        hostChecks.set(host, p);
      }
      return p;
    };
    const off = cdp.on((m) => {
      if (m.sessionId !== session || !m.params) return;
      const p = m.params as Record<string, unknown>;
      if (m.method === "Fetch.requestPaused") {
        const req = p.request as { url: string; method: string };
        const id = p.requestId as string;
        // 로그인 상태로 읽을 때는 페이지 이동을 GET 으로만 (폼 자동 제출 등으로 뭔가 바뀌지 않게)
        const write = !!opt.readOnly && p.resourceType === "Document" && req.method !== "GET" && req.method !== "HEAD";
        void (async () => {
          const ok = !write && !SKIP_TYPES.has(String(p.resourceType)) && (await allowed(req.url));
          await cdp
            .send(
              ok ? "Fetch.continueRequest" : "Fetch.failRequest",
              ok ? { requestId: id } : { requestId: id, errorReason: "BlockedByClient" },
              session,
            )
            .catch(() => {});
        })();
      } else if (m.method === "Network.responseReceived" && p.type === "Document" && p.frameId === mainFrame) {
        httpStatus = Number((p.response as { status?: number }).status ?? 0);
      } else if (m.method === "Page.loadEventFired") loaded = true;
    });
    let targetId = "";
    try {
      ({ targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
        browserContextId,
      }));
      mainFrame = targetId; // 최상위 frame id = target id (navigate 응답보다 문서 응답이 먼저 올 수 있다)
      ({ sessionId: session } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      }));
      await cdp.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId }).catch(() => {});
      await cdp.send("Network.enable", {}, session);
      await cdp.send("Network.setUserAgentOverride", { userAgent: USER_AGENT }, session);
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, session);
      await cdp.send("Page.enable", {}, session);
      await cdp.send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: "window.open = function () { return null; };" },
        session,
      );
      const timeoutMs = this.opt.timeoutMs ?? 20_000;
      return await fn({
        cdp,
        session,
        get loaded() {
          return loaded;
        },
        get httpStatus() {
          return httpStatus;
        },
        resetLoad() {
          loaded = false;
        },
        async goto(url, signal) {
          loaded = false;
          httpStatus = 0;
          const nav = await cdp.send<{ frameId: string; errorText?: string }>("Page.navigate", { url }, session);
          if (nav.frameId) mainFrame = nav.frameId;
          if (nav.errorText) return nav.errorText;
          const deadline = Date.now() + timeoutMs;
          while (!loaded && Date.now() < deadline && !signal?.aborted) await Bun.sleep(100);
          if (signal?.aborted) return "cancelled";
          if (loaded) await Bun.sleep(800); // 늦게 그리는 스크립트
          return null;
        },
        async evaluate<V>(expression: string) {
          const r = await cdp.send<{ result: { value?: V } }>(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            session,
          );
          return r.result.value;
        },
      });
    } finally {
      off();
      if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  private async readPage(p: PageHandle, url: string, signal?: AbortSignal): Promise<PageResult> {
    const err = await p.goto(url, signal);
    if (err) return empty(url, "error", err);
    const ex = await p.evaluate<Extracted>(extractExpression());
    const finalUrl = (await p.evaluate<string>("location.href").catch(() => url)) ?? url;
    const httpStatus = p.httpStatus;
    if (!ex) return empty(url, "error", "extract failed", httpStatus);
    const status: PageStatus =
      httpStatus === 403 ||
      httpStatus === 429 ||
      httpStatus === 503 ||
      (ex.text.length < 1500 && BLOCKED_TEXT.test(`${ex.title} ${ex.text}`))
        ? "blocked"
        : httpStatus >= 400
          ? "error"
          : !p.loaded && ex.text.length < 200
            ? "timeout"
            : "ok";
    const hasPassword = (await p.evaluate<boolean>(HAS_PASSWORD).catch(() => false)) ?? false;
    return {
      ...ex,
      url,
      finalUrl,
      status,
      httpStatus,
      reason: status === "ok" ? "" : `HTTP ${httpStatus}`,
      hasPassword,
    };
  }
}
