import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THEME_LIMITS } from "@proprix/shared";
import { strToU8, zipSync } from "fflate";
import { bundleCss, parseTheme, ThemeError, ThemeStore } from "./store";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const WOFF2 = strToU8("wOF2data");
const manifest = (extra: object = {}) =>
  strToU8(
    JSON.stringify({ format: "proprix-theme", version: 1, id: "sample", name: "견본", css: "theme.css", ...extra }),
  );
const pack = (css: string, extra: object = {}, files: Record<string, Uint8Array> = {}) =>
  zipSync({ "theme.json": manifest(extra), "theme.css": strToU8(css), ...files });
const fails = (z: Uint8Array, text: string) => {
  expect(() => parseTheme(z)).toThrow(ThemeError);
  expect(() => parseTheme(z)).toThrow(text);
};

test("테마 읽기: 정보와 CSS, url() 은 묶음 안 파일의 data URL 로", () => {
  const b = parseTheme(
    pack(
      `:root[data-theme="sample"] { --c-bg: #000; background: url(img/a.png); } /* 지워짐 */`,
      { notice: "비공식", fontCss: "fonts.css" },
      {
        "img/a.png": PNG,
        "fonts.css": strToU8(
          `@font-face { font-family: "X"; src: url("../f/x.woff2") format("woff2"); }`.replace("../f/", "f/"),
        ),
        "f/x.woff2": WOFF2,
      },
    ),
  );
  expect(b).toMatchObject({ id: "sample", name: "견본", notice: "비공식" });
  expect(b.css).toContain('url("data:image/png;base64,');
  expect(b.css).not.toContain("지워짐");
  expect(b.fontCss).toContain('url("data:font/woff2;base64,');
});

test("폴더째 압축한 zip 도 받고, css 위치 기준으로 상대 경로를 푼다", () => {
  const z = zipSync({
    "pack/theme.json": manifest({ css: "css/theme.css" }),
    "pack/css/theme.css": strToU8("a { background: url(../img/a.png) }"),
    "pack/img/a.png": PNG,
  });
  expect(parseTheme(z).css).toContain("data:image/png");
});

test("CSS 거부: 외부 주소·@import·이스케이프·실행 구문", () => {
  const files = new Map<string, Uint8Array>();
  for (const css of [
    "a { background: url(https://evil.test/x.png) }",
    "a { background: url(//evil.test/x.png) }",
    '@import "other.css";',
    "a { background: u\\72l(x) }",
    "a { width: expression(alert(1)) }",
    'a { background: image-set("x.png" 1x) }',
    "a { background: url(data:image/png;base64,AAAA) }",
    "</style><script>x</script>",
    "a { background: url('//evil.test/x)y') }",
    'a { background: url("//evil.test/(x)") }',
    "a { background: image('//evil.test/x.png') }",
  ])
    expect(() => bundleCss(css, "theme.css", files)).toThrow(ThemeError);
  // 주석에 숨긴 것은 지우므로 문제없다
  expect(bundleCss("/* @import x */ a { color: red }", "theme.css", files)).toContain("color: red");
});

test("거부: 설명 파일·형식·id·없는 파일·svg 스크립트·경로·크기", () => {
  fails(zipSync({ "theme.css": strToU8("") }), "theme.json");
  fails(zipSync({ "theme.json": strToU8("{"), "theme.css": strToU8("") }), "JSON");
  fails(pack("", { format: "other" }), "형식");
  fails(pack("", { id: "../up" }), "형식");
  fails(pack("", { id: "studio" }), "형식");
  fails(zipSync({ "theme.json": manifest() }), "없는 파일");
  fails(pack("a { background: url(none.png) }"), "없는 파일");
  fails(
    pack("a { background: url(a.svg) }", {}, { "a.svg": strToU8("<svg><script>x</script></svg>") }),
    "이미지·글꼴만",
  );
  fails(pack("a { background: url(a.txt) }", {}, { "a.txt": strToU8("글") }), "이미지·글꼴만");
  fails(zipSync({ "theme.json": manifest(), "theme.css": strToU8(""), "../evil": PNG }), "경로");
  fails(
    zipSync({ "theme.json": manifest(), "theme.css": strToU8(""), big: new Uint8Array(THEME_LIMITS.totalBytes + 1) }),
    "전체 크기",
  );
  fails(strToU8("zip 아님"), "읽을 수 없습니다");
});

test("svg 는 스크립트가 없으면 받는다", () => {
  const b = parseTheme(
    pack(
      "a { background: url(a.svg) }",
      {},
      { "a.svg": strToU8('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>') },
    ),
  );
  expect(b.css).toContain("data:image/svg+xml");
});

test("저장소: 저장·목록·교체·실패해도 유지·삭제", () => {
  const dir = mkdtempSync(join(tmpdir(), "proprix-theme-"));
  const store = new ThemeStore(dir);
  expect(store.list()).toEqual([]);
  const a = store.save(pack("a { color: red }"));
  expect(store.list()).toEqual([a]);
  expect(store.bundle("sample")?.css).toContain("color: red");
  expect(() => store.save(strToU8("깨짐"))).toThrow(ThemeError);
  expect(store.list()).toEqual([a]);
  const b = store.save(pack("a { color: blue }"));
  expect(b.version).not.toBe(a.version);
  expect(readdirSync(dir)).toEqual(["sample"]);
  expect(store.remove("sample")).toBe(true);
  expect(store.list()).toEqual([]);
  expect(store.remove("sample")).toBe(false);
});

test("테마가 화면 이름을 바꿀 수 있다 (짧은 문구만)", () => {
  expect(parseTheme(pack("", { labels: { debate: "회의" } })).labels).toEqual({ debate: "회의" });
  expect(parseTheme(pack("")).labels).toEqual({});
  fails(pack("", { labels: { debate: "가".repeat(31) } }), "형식");
});
