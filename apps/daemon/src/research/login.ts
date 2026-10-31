// 사이트 자동 로그인 (P12c): 앱의 규칙으로 로그인 폼을 찾아 입력한다. 모델은 관여하지 않는다.
// - 페이지 주소와 폼 제출 주소가 등록 도메인(또는 하위)이고 https 일 때만 입력한다 (SSO 등 다른 도메인이면 입력하지 않음)
// - 2단계 인증·CAPTCHA 가 보이면 우회하지 않고 멈춘다
// - 비밀번호는 스크립트 문자열이 아니라 CDP 입력(Input.insertText)으로 넣는다. 로그·오류에 남기지 않는다
import type { SiteAccount, SiteAccountOutcome } from "@proprix/shared";
import type { Cdp } from "./cdp";
import { domainMatches } from "./policy";

export interface PageHandle {
  readonly cdp: Cdp;
  readonly session: string;
  goto(url: string, signal?: AbortSignal): Promise<string | null>; // 오류 글 또는 null
  evaluate<T>(expression: string): Promise<T | undefined>;
  readonly loaded: boolean;
  resetLoad(): void;
}

interface FormState {
  href: string;
  hasPassword: boolean;
  hasUser: boolean;
  action: string;
  otp: boolean;
  captcha: boolean;
}

// 칸 찾기: 보이는 비밀번호 칸, 그 앞의 아이디 칸 (비밀번호 칸이 없으면 아이디처럼 보이는 칸 — 아이디 먼저 받는 폼)
const FIND = `
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const all = [...document.querySelectorAll('input')].filter(vis);
  const pw = all.find((i) => i.type === 'password') ?? null;
  const texty = (i) => ['text', 'email', 'tel', ''].includes(i.getAttribute('type') ?? '') && !i.readOnly && !i.disabled;
  const user = pw
    ? all.slice(0, all.indexOf(pw)).filter(texty).at(-1) ?? null
    : all.filter(texty).find((i) => /user|mail|login|account|id|아이디|이메일/i.test([i.name, i.id, i.autocomplete, i.placeholder].join(' '))) ?? null;
`;

const STATE = `(() => {${FIND}
  const form = (pw ?? user)?.form ?? null;
  const text = (document.body?.innerText ?? '').slice(0, 5000);
  return {
    href: location.href,
    hasPassword: !!pw,
    hasUser: !!user,
    action: form ? form.action : '',
    otp: all.some((i) => i.autocomplete === 'one-time-code') || (!pw && /인증\\s*번호|2단계|2차\\s*인증|two[- ]factor|verification code|authenticator|one[- ]time/i.test(text) && all.length > 0),
    captcha: !!document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[src*="captcha"], iframe[src*="challenge"]') || (text.length < 1500 && /captcha|verify you are (a )?human|are you a robot/i.test(text)),
  };
})()`;

const field = (which: "pw" | "user") => `(() => {${FIND} return ${which}; })()`;

// 페이지에 비밀번호 칸이 보이는가 (로그인 벽 판단)
export const HAS_PASSWORD = `(() => {${FIND} return !!pw; })()`;

async function handleOf(p: PageHandle, which: "pw" | "user"): Promise<string | undefined> {
  const r = await p.cdp.send<{ result: { objectId?: string } }>(
    "Runtime.evaluate",
    { expression: field(which) },
    p.session,
  );
  return r.result.objectId;
}

async function typeInto(p: PageHandle, which: "pw" | "user", text: string): Promise<boolean> {
  const objectId = await handleOf(p, which);
  if (!objectId) return false;
  await p.cdp.send(
    "Runtime.callFunctionOn",
    { objectId, functionDeclaration: "function () { this.focus(); this.value = ''; }" },
    p.session,
  );
  await p.cdp.send("Input.insertText", { text }, p.session);
  return true;
}

async function submit(p: PageHandle, which: "pw" | "user") {
  const objectId = await handleOf(p, which);
  const clicked = objectId
    ? await p.cdp.send<{ result: { value?: boolean } }>(
        "Runtime.callFunctionOn",
        {
          objectId,
          returnByValue: true,
          functionDeclaration: `function () {
            const f = this.form;
            const b = f && f.querySelector('button[type=submit], input[type=submit], button:not([type])');
            if (b) { b.click(); return true; }
            if (f && f.requestSubmit) { f.requestSubmit(); return true; }
            return false;
          }`,
        },
        p.session,
      )
    : null;
  if (clicked?.result.value) return;
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await p.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" }, p.session);
  await p.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, p.session);
}

export async function performLogin(
  p: PageHandle,
  account: SiteAccount,
  password: string,
  opt: { allowHttp?: boolean; signal?: AbortSignal; waitMs?: number } = {},
): Promise<SiteAccountOutcome> {
  const hostOk = (u: string) => {
    try {
      const url = new URL(u);
      return (url.protocol === "https:" || !!opt.allowHttp) && domainMatches(url.hostname, [account.domain]);
    } catch {
      return false;
    }
  };
  const state = () => p.evaluate<FormState>(STATE);
  // 주소 검사를 통과해야만 입력한다 (입력 직전에 다시 본다)
  const refuse = (s: FormState): SiteAccountOutcome | null =>
    !hostOk(s.href) || (s.action !== "" && !hostOk(s.action))
      ? "redirect_host"
      : s.captcha
        ? "captcha"
        : s.otp && !s.hasPassword
          ? "two_factor"
          : null;
  const waitFor = async (done: (s: FormState) => boolean): Promise<FormState | undefined> => {
    const deadline = Date.now() + (opt.waitMs ?? 8000);
    while (Date.now() < deadline && !opt.signal?.aborted) {
      await Bun.sleep(300);
      const s = await state().catch(() => undefined); // 이동 중이면 잠깐 실패할 수 있다
      if (s && (p.loaded || done(s))) {
        await Bun.sleep(500);
        return state().catch(() => s);
      }
    }
    return state().catch(() => undefined);
  };

  const err = await p.goto(account.loginUrl, opt.signal);
  if (err) return "error";
  let s = await state();
  if (!s) return "error";
  for (let step = 0; step < 2; step++) {
    const no = refuse(s);
    if (no) return no;
    if (!s.hasPassword && !s.hasUser) return "no_form";
    const hadPassword = s.hasPassword;
    if (s.hasUser && !(await typeInto(p, "user", account.username))) return "no_form";
    if (hadPassword) {
      const check = await state();
      if (!check) return "error";
      const late = refuse(check);
      if (late) return late;
      if (!(await typeInto(p, "pw", password))) return "no_form";
    }
    p.resetLoad();
    await submit(p, hadPassword ? "pw" : "user");
    const next = await waitFor((x) => (hadPassword ? !x.hasPassword : x.hasPassword));
    if (!next) return "error";
    s = next;
    if (hadPassword) break;
    if (!s.hasPassword) return refuse(s) ?? "no_form"; // 아이디 다음에 비밀번호 칸이 나와야 한다
  }
  const after = refuse(s);
  if (after) return after;
  return s.hasPassword ? "wrong_credentials" : "ok";
}
