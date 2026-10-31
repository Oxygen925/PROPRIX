import { expect, test } from "bun:test";
import { cleanTitle, isDefaultTitle } from "./title";

test("기본 이름만 자동 제목 대상", () => {
  expect(isDefaultTitle("새 대화")).toBe(true);
  expect(isDefaultTitle("새 대화 (비서)")).toBe(true);
  expect(isDefaultTitle("새 대화 정리")).toBe(false);
  expect(isDefaultTitle("서브: 새 대화")).toBe(false);
  expect(isDefaultTitle("이어폰 비교")).toBe(false);
});

test("제목 다듬기: 한 줄, 따옴표·머리말·끝 문장 부호 제거, 길면 자름", () => {
  expect(cleanTitle('"이어폰 비교"\n설명은 생략')).toBe("이어폰 비교");
  expect(cleanTitle("제목: 일정 정리.")).toBe("일정 정리");
  expect(cleanTitle("**Trip plan**")).toBe("Trip plan");
  expect(cleanTitle("   ")).toBe("");
  expect(cleanTitle("가".repeat(50))).toBe(`${"가".repeat(40)}…`);
});
