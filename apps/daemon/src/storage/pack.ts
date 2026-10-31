// zip 묶음 공통 (페르소나 표정·테마): 안전하게 풀기, 매니페스트 읽기, 폴더 통째로 바꾸기.
// 오류는 묶음마다 자기 클래스로 낸다 (라우트가 그 클래스만 400 으로 바꾼다)
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import type { z } from "zod";

export type PackError = new (message: string) => Error;

export const MB = (n: number) => `${Math.round(n / 1024 / 1024)}MB`;

function badEntry(name: string): boolean {
  return name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..");
}

// 폴더째 압축한 zip: 모든 파일이 한 폴더 아래에 있으면 그 폴더를 벗긴다
function stripTopFolder(files: Map<string, Uint8Array>, manifest: string): Map<string, Uint8Array> {
  if (files.has(manifest)) return files;
  const tops = new Set([...files.keys()].map((n) => (n.includes("/") ? n.split("/")[0] : "")));
  const top = tops.size === 1 ? [...tops][0] : "";
  if (!top) return files;
  return new Map([...files].map(([n, b]) => [n.slice(top.length + 1), b]));
}

export function readPackZip(
  zip: Uint8Array,
  manifest: string,
  limits: { zipBytes: number; files: number; totalBytes: number },
  Err: PackError,
): Map<string, Uint8Array> {
  if (zip.length > limits.zipBytes) throw new Err(`zip 은 ${MB(limits.zipBytes)} 까지입니다`);
  let count = 0;
  let declared = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, {
      // 풀기 전에 선언된 크기·개수로 거른다 (압축 폭탄)
      filter: (f) => {
        if (f.name.endsWith("/") || f.name.startsWith("__MACOSX/")) return false;
        if (badEntry(f.name)) throw new Err(`zip 안의 경로가 잘못됐습니다: ${f.name.slice(0, 80)}`);
        count++;
        declared += f.originalSize;
        if (count > limits.files) throw new Err(`파일은 ${limits.files}개까지입니다`);
        if (declared > limits.totalBytes) throw new Err(`전체 크기는 ${MB(limits.totalBytes)} 까지입니다`);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof Err) throw e;
    throw new Err("zip 파일을 읽을 수 없습니다");
  }
  return stripTopFolder(new Map(Object.entries(entries)), manifest);
}

// 매니페스트 JSON 을 읽어 검증한다. precheck: 스키마 검사 전에 따로 거를 것
export function parseManifest<S extends z.ZodType>(
  files: ReadonlyMap<string, Uint8Array>,
  opt: { manifest: string; format: string; schema: S; Err: PackError; precheck?: (json: unknown) => void },
): z.output<S> {
  const { manifest, format, schema, Err } = opt;
  const raw = files.get(manifest);
  if (!raw) throw new Err(`zip 맨 위에 ${manifest} 가 없습니다`);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Err(`${manifest} 의 JSON 형식이 잘못됐습니다`);
  }
  opt.precheck?.(json);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Err(`${manifest} 가 ${format} 형식이 아닙니다 (${why})`);
  }
  return parsed.data;
}

// 임시 폴더에 다 쓴 뒤 옮겨 실패해도 이전 내용이 남는다
export function replaceFolder(dir: string, target: string, write: (tmp: string) => void) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${crypto.randomUUID()}`);
  mkdirSync(tmp);
  try {
    write(tmp);
    rmSync(target, { recursive: true, force: true });
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}
