import { expect, test } from "bun:test";
import type { Persona } from "@proprix/shared";
import { contentDisposition, exportJson, exportMarkdown, importJson, importMarkdown } from "./persona-file";

const persona: Persona = {
  id: "p1",
  character: null,
  name: "파랑",
  emoji: "🐟",
  color: "#3366ff",
  description: "테스트",
  body: "- 말투: 존댓말",
  petCharacterId: "test-blue",
  avatarImage: "",
  builtin: false,
  createdAt: 1,
  updatedAt: 2,
};

test("JSON 왕복, id·시각은 내보내지 않음", () => {
  const file = exportJson(persona);
  expect(JSON.stringify(file)).not.toContain('"id"');
  const back = importJson(JSON.parse(JSON.stringify(file)));
  expect(back).toEqual({
    name: "파랑",
    emoji: "🐟",
    color: "#3366ff",
    description: "테스트",
    body: "- 말투: 존댓말",
    petCharacterId: "test-blue",
    avatarImage: "",
  });
});

test("잘못된 JSON 은 사유를 돌려준다", () => {
  expect(typeof importJson({ format: "other" })).toBe("string");
  expect(typeof importJson({ ...exportJson(persona), persona: { ...exportJson(persona).persona, color: "red" } })).toBe(
    "string",
  );
  expect(
    typeof importJson({ ...exportJson(persona), persona: { ...exportJson(persona).persona, emoji: "🐟🐟" } }),
  ).toBe("string");
});

test("desktop_pet persona.md 가져오기: 이름 줄 인식, 없으면 기본값", () => {
  const md = "<!-- 예제 -->\r\n- 이름: 윈도울링 (Windowling)\r\n- 말투: 존댓말\r\n";
  const p = importMarkdown(md);
  expect(p.name).toBe("윈도울링 (Windowling)");
  expect(p.body).toBe("<!-- 예제 -->\n- 이름: 윈도울링 (Windowling)\n- 말투: 존댓말");
  expect(importMarkdown("성격: 차분함").name).toBe("가져온 페르소나");
  expect(importMarkdown("name: Kit", "직접").name).toBe("직접");
  expect(exportMarkdown(persona)).toBe("- 말투: 존댓말\n");
});

test("Content-Disposition 은 경로·따옴표를 막고 UTF-8 이름을 붙인다", () => {
  const h = contentDisposition('../a"b/파랑', "json");
  expect(h).toContain('filename=".._a_b_');
  expect(h).not.toContain("/");
  expect(h).toContain(`filename*=UTF-8''${encodeURIComponent(".._a_b_파랑.json")}`);
});
