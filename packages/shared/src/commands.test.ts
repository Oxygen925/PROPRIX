import { expect, test } from "bun:test";
import {
  CommandInput,
  commandKey,
  commandNameError,
  expandCommand,
  MESSAGE_MAX,
  parseSlash,
  requiredArgs,
  splitArgs,
} from "./commands";

test("이름: 형식·예약어(대소문자 무시)·NFC", () => {
  expect(commandNameError("요약")).toBe("");
  expect(commandNameError("fix-bug_2")).toBe("");
  expect(commandNameError("2fix")).not.toBe("");
  expect(commandNameError("-a")).not.toBe("");
  expect(commandNameError("a b")).not.toBe("");
  expect(commandNameError("a".repeat(33))).not.toBe("");
  expect(commandNameError("New")).toContain("내장");
  expect(commandNameError("HELP")).toContain("내장");
  // 풀어 쓴(NFD) 한글도 같은 키
  const nfd = "한글".normalize("NFD");
  expect(nfd).not.toBe("한글");
  expect(commandKey(nfd)).toBe(commandKey("한글"));
  expect(commandNameError(nfd)).toBe("");
  expect(commandKey("ReView")).toBe("review");
  expect(CommandInput.parse({ name: ` ${nfd} `, template: "x" }).name).toBe("한글");
  expect(CommandInput.safeParse({ name: "pin", template: "x" }).success).toBe(false);
});

test("입력 해석: 경로는 명령이 아니다", () => {
  expect(parseSlash("/review  a b ")).toEqual({ name: "review", rest: "a b" });
  expect(parseSlash("/pin")).toEqual({ name: "pin", rest: "" });
  expect(parseSlash("/요약\n둘째 줄")).toEqual({ name: "요약", rest: "둘째 줄" });
  expect(parseSlash("/etc/hosts가 뭐야")).toBeNull();
  expect(parseSlash("안녕 /pin")).toBeNull();
  expect(parseSlash("/")).toBeNull();
});

test('인자 나누기: 따옴표·\\" ·다른 역슬래시·닫히지 않은 따옴표·줄바꿈', () => {
  expect(splitArgs('a "b c" d')).toEqual(["a", "b c", "d"]);
  expect(splitArgs('say \\"hi\\"')).toEqual(["say", '"hi"']);
  expect(splitArgs('"C:\\Users\\x" C:\\path')).toEqual(["C:\\Users\\x", "C:\\path"]);
  expect(splitArgs('a "b c')).toEqual(["a", "b c"]);
  expect(splitArgs('a "" b')).toEqual(["a", "", "b"]);
  expect(splitArgs("a\nb\t c")).toEqual(["a", "b", "c"]);
  expect(splitArgs("   ")).toEqual([]);
});

test("펼치기: $ARGUMENTS·$N·$$·모르는 $이름·$10", () => {
  const t = "파일 $1 을(를) $2 로. 전체: $ARGUMENTS / $$1 / $HOME / $ARGUMENTSX / $10";
  const r = expandCommand(t, '  a.ts "새 이름"  ');
  expect(r.text).toBe('파일 a.ts 을(를) 새 이름 로. 전체: a.ts "새 이름" / $1 / $HOME / $ARGUMENTSX / a.ts0');
  expect(r.required).toBe(2);
  expect(r.missing).toEqual([]);
  // 없는 인자는 빈 문자열, 필수로 알린다
  const m = expandCommand("$1-$3", "x");
  expect(m.text).toBe("x-");
  expect(m.missing).toEqual([2, 3]);
  // $ARGUMENTS 는 줄바꿈을 지킨다
  expect(expandCommand("[$ARGUMENTS]", "한 줄\n두 줄").text).toBe("[한 줄\n두 줄]");
  expect(requiredArgs("$$1 $ARGUMENTS")).toBe(0);
});

test("자리표시 없는 템플릿에 인자를 주면 빈 줄 뒤에 붙인다 ($$ 는 자리표시가 아님)", () => {
  expect(expandCommand("리뷰해 줘 $$", "a.ts").text).toBe("리뷰해 줘 $\n\na.ts");
  expect(expandCommand("리뷰해 줘", "").text).toBe("리뷰해 줘");
  expect(expandCommand("[$ARGUMENTS]", "").text).toBe("[]");
});

test("펼친 결과 길이 상한", () => {
  expect(expandCommand("x".repeat(MESSAGE_MAX), "").tooLong).toBe(false);
  expect(expandCommand(`${"x".repeat(MESSAGE_MAX - 1)}$1`, "ab").tooLong).toBe(true);
});
