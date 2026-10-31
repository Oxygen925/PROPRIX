// / 명령: 이름 규칙·예약어·템플릿 인자. 입력창(보내기 전 검사·팝업)과 daemon(저장 검사·미리보기)이 같이 쓴다
import { z } from "zod";

export const MESSAGE_MAX = 20_000; // 메시지 상한 — 펼친 결과도 이 안이어야 한다

// 1~32자, 한글·영문·숫자·-·_ , 첫 글자는 문자 (NFC 로 맞춘 뒤 검사)
const NAME_RE = /^[A-Za-z가-힣][A-Za-z0-9가-힣_-]{0,31}$/;

/** 비교용 키: NFC + 영문만 소문자 (한글은 그대로) */
export function commandKey(name: string): string {
  return name.normalize("NFC").replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export interface BuiltinCommand {
  name: string;
  args: string; // 사용법 힌트 ("" = 인자 없음)
  description: string;
  lounge: boolean; // 라운지에서도 쓸 수 있음
}

// 웹에서 바로 실행한다. 이름은 예약어 (사용자 정의·skill 모두 쓸 수 없음)
export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  { name: "new", args: "[첫 메시지]", description: "같은 참여자로 새 채팅", lounge: false },
  { name: "model", args: "[모델 이름]", description: "모델 바꾸기 (없으면 목록)", lounge: true },
  { name: "effort", args: "[자동|낮음|보통|높음|매우높음]", description: "추론 강도 (1인 채팅)", lounge: false },
  { name: "dir", args: "", description: "작업 폴더 지정·설정", lounge: false },
  { name: "debate", args: "[주제]", description: "토론 시작 (다른 에이전트도 초대)", lounge: false },
  { name: "collab", args: "[만들 것]", description: "협업 시작 (다른 에이전트도 초대)", lounge: false },
  { name: "team", args: "[팀 이름]", description: "그 팀으로 새 채팅 (이름 없으면 고르기)", lounge: true },
  { name: "search", args: "[검색어]", description: "채팅 검색", lounge: true },
  { name: "export", args: "", description: "마크다운으로 내보내기", lounge: true },
  { name: "pin", args: "", description: "맨 위에 고정·해제", lounge: false },
  { name: "archive", args: "", description: "보관·보관 해제", lounge: false },
  { name: "summary", args: "", description: "이전 채팅 요약 보기", lounge: true },
  { name: "memory", args: "", description: "지금 기억 추출 (플랜 사용량)", lounge: true },
  { name: "help", args: "", description: "명령어 목록", lounge: true },
];

export const builtinCommand = (name: string): BuiltinCommand | undefined => {
  const key = commandKey(name);
  return BUILTIN_COMMANDS.find((c) => c.name === key);
};

/** 이름 형식·예약어 검사. 문제가 없으면 "" (다른 명령·skill 과의 겹침은 저장할 때 따로) */
export function commandNameError(name: string): string {
  const n = name.normalize("NFC");
  if (!NAME_RE.test(n)) return "이름은 1~32자, 한글·영문·숫자·-·_ 만 쓰고 문자로 시작해야 합니다";
  if (builtinCommand(n)) return `/${commandKey(n)} 은(는) 내장 명령어라 쓸 수 없습니다`;
  return "";
}

export const CommandInput = z.object({
  name: z
    .string()
    .trim()
    .transform((s) => s.normalize("NFC"))
    .superRefine((s, ctx) => {
      const e = commandNameError(s);
      if (e) ctx.addIssue({ code: "custom", message: e });
    }),
  description: z.string().trim().max(200).default(""),
  template: z.string().min(1).max(MESSAGE_MAX),
});
export type CommandInput = z.infer<typeof CommandInput>;
export const Command = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  template: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Command = z.infer<typeof Command>;
export const CommandPreviewRequest = z.object({
  template: z.string().max(MESSAGE_MAX),
  args: z.string().max(MESSAGE_MAX),
});
export const CommandPreview = z.object({
  text: z.string(),
  required: z.number(), // 필수 인자 수 ($1..$9 중 가장 큰 번호)
  missing: z.array(z.number()), // 비어 있는 필수 인자 번호
  tooLong: z.boolean(),
});
export type CommandPreview = z.infer<typeof CommandPreview>;

// ---- 입력 해석 ----

/** "/이름 나머지" → 이름·나머지. "/" 로 시작해도 첫 덩어리에 / 가 또 있으면 (경로) 명령이 아니다 */
export function parseSlash(text: string): { name: string; rest: string } | null {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text);
  return m ? { name: m[1] ?? "", rest: (m[2] ?? "").trim() } : null;
}

/**
 * 인자 나누기: 공백(줄바꿈 포함)으로 나누되 "…" 는 한 덩어리, \" 는 따옴표 글자.
 * 다른 \ 는 그대로 (C:\path). 닫히지 않은 따옴표는 끝까지 한 덩어리
 */
export function splitArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] ?? "";
    if (c === "\\" && raw[i + 1] === '"') {
      cur += '"';
      has = true;
      i++;
    } else if (c === '"') {
      quoted = !quoted;
      has = true;
    } else if (!quoted && /\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

type Part = { t: "text"; v: string } | { t: "all" } | { t: "arg"; n: number };

// 왼쪽부터 한 번에: $$ → $, $1..$9 (한 자리 — $10 은 $1 뒤 0), $ARGUMENTS (뒤가 단어 글자가 아닐 때). 그 밖의 $ 는 글자
function parseTemplate(tpl: string): Part[] {
  const parts: Part[] = [];
  let text = "";
  const flush = () => {
    if (text) parts.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < tpl.length) {
    const c = tpl[i] ?? "";
    const next = tpl[i + 1] ?? "";
    if (c !== "$") {
      text += c;
      i++;
    } else if (next === "$") {
      text += "$";
      i += 2;
    } else if (/[1-9]/.test(next)) {
      flush();
      parts.push({ t: "arg", n: Number(next) });
      i += 2;
    } else if (tpl.startsWith("ARGUMENTS", i + 1) && !/[A-Za-z0-9_]/.test(tpl[i + 10] ?? "")) {
      flush();
      parts.push({ t: "all" });
      i += 10;
    } else {
      text += "$";
      i++;
    }
  }
  flush();
  return parts;
}

/** 템플릿의 필수 인자 수 ($1..$9 중 가장 큰 번호, 없으면 0) */
export function requiredArgs(tpl: string): number {
  return Math.max(0, ...parseTemplate(tpl).map((p) => (p.t === "arg" ? p.n : 0)));
}

/**
 * 템플릿 펼치기. $ARGUMENTS = 명령 뒤 원문 그대로 (앞뒤 공백 제거), $N = N번째 인자 (없으면 "").
 * 자리표시가 없는 템플릿에 인자를 주면 빈 줄 뒤에 붙인다
 */
export function expandCommand(tpl: string, raw: string): CommandPreview {
  const rest = raw.trim();
  const args = splitArgs(rest);
  const parts = parseTemplate(tpl);
  const required = requiredArgs(tpl);
  const missing: number[] = [];
  for (let n = 1; n <= required; n++) if (n > args.length) missing.push(n);
  let text = parts.map((p) => (p.t === "text" ? p.v : p.t === "all" ? rest : (args[p.n - 1] ?? ""))).join("");
  if (rest && !parts.some((p) => p.t !== "text")) text = `${text}\n\n${rest}`;
  return { text, required, missing, tooLong: text.length > MESSAGE_MAX };
}
