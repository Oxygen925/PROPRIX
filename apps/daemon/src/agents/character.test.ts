import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHARACTER_LIMITS } from "@proprix/shared";
import { strToU8, zipSync } from "fflate";
import { CharacterError, CharacterStore, parsePack } from "./character";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const WEBP = new Uint8Array([...strToU8("RIFF"), 0, 0, 0, 0, ...strToU8("WEBP"), 9]);
const manifest = (extra: object = {}) =>
  strToU8(
    JSON.stringify({
      format: "proprix-character",
      version: 1,
      kind: "expressions",
      expressions: { idle: "idle.png" },
      ...extra,
    }),
  );
const zip = (files: Record<string, Uint8Array>) => zipSync(files);
const fails = (z: Uint8Array, text: string) => {
  expect(() => parsePack(z)).toThrow(CharacterError);
  expect(() => parsePack(z)).toThrow(text);
};

test("묶음 읽기: 표정과 파일을 잇고, 쓰지 않는 파일은 버리며 같은 파일은 한 번만 저장한다", () => {
  const { stored, images } = parsePack(
    zip({
      "character.json": manifest({
        thumbnail: "idle.png",
        expressions: { idle: "idle.png", thinking: "t.webp", talking: ["idle.png", "t.webp"] },
      }),
      "idle.png": PNG,
      "t.webp": WEBP,
      "notes.txt": strToU8("남기지 않음"),
    }),
  );
  expect(images.size).toBe(2);
  expect(stored.expressions).toEqual({ idle: ["0.png"], thinking: ["1.webp"], talking: ["0.png", "1.webp"] });
  expect(stored.thumbnail).toBe("0.png");
});

test("폴더째 압축한 zip 도 받는다", () => {
  const { images } = parsePack(zip({ "pack/character.json": manifest(), "pack/idle.png": PNG }));
  expect(images.size).toBe(1);
});

test("거부: 설명 파일 없음·형식 오류·idle 없음·없는 파일·이미지 아님·Live2D·깨진 zip", () => {
  fails(zip({ "idle.png": PNG }), "character.json");
  fails(zip({ "character.json": strToU8("{"), "idle.png": PNG }), "JSON");
  fails(zip({ "character.json": manifest({ format: "other" }), "idle.png": PNG }), "형식");
  fails(zip({ "character.json": manifest({ expressions: { blink: "idle.png" } }), "idle.png": PNG }), "idle");
  fails(zip({ "character.json": manifest({ expressions: { idle: "none.png" } }) }), "없는 파일");
  fails(zip({ "character.json": manifest({ expressions: { idle: "x.svg" } }), "x.svg": strToU8("<svg/>") }), "png");
  fails(zip({ "character.json": manifest({ kind: "live2d" }) }), "Live2D");
  fails(strToU8("zip 이 아님"), "읽을 수 없습니다");
});

test("거부: 경로 탈출·개수·크기 (압축 폭탄 포함)", () => {
  fails(zip({ "character.json": manifest(), "idle.png": PNG, "../evil.png": PNG }), "경로");
  const many = Object.fromEntries(Array.from({ length: CHARACTER_LIMITS.files + 1 }, (_, i) => [`${i}.png`, PNG]));
  fails(zip({ "character.json": manifest(), ...many }), "개까지");
  // 잘 압축되는 큰 파일: 풀기 전에 걸러야 한다
  fails(
    zip({ "character.json": manifest(), "idle.png": new Uint8Array(CHARACTER_LIMITS.totalBytes + 1) }),
    "전체 크기",
  );
  const big = new Uint8Array(CHARACTER_LIMITS.fileBytes + 1);
  big.set(PNG);
  fails(zip({ "character.json": manifest(), "idle.png": big }), "이미지 하나");
});

test("저장소: 저장·읽기·교체·실패해도 이전 묶음 유지·삭제", () => {
  const dir = mkdtempSync(join(tmpdir(), "proprix-character-"));
  const store = new CharacterStore(dir);
  const id = "11111111-1111-4111-8111-111111111111";
  expect(store.version(id)).toBeNull();
  const good = zip({ "character.json": manifest(), "idle.png": PNG });
  const v1 = store.save(id, good);
  expect(store.version(id)).toBe(v1);
  expect(new CharacterStore(dir).version(id)).toBe(v1); // 재시작 뒤에도
  expect(store.pack(id)?.expressions.idle?.[0]).toStartWith("data:image/png;base64,");
  expect(store.source(id)).toEqual(good);

  expect(() => store.save(id, strToU8("깨짐"))).toThrow(CharacterError);
  expect(store.version(id)).toBe(v1);
  expect(store.pack(id)).not.toBeNull();

  const v2 = store.save(id, good);
  expect(v2).not.toBe(v1);
  expect(readdirSync(dir)).toEqual([id]); // 임시 폴더가 남지 않는다

  expect(store.remove(id)).toBe(true);
  expect(store.version(id)).toBeNull();
  expect(store.pack(id)).toBeNull();
  expect(store.remove(id)).toBe(false);
});
