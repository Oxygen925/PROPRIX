// 가져오기 원본 → 파일 목록. 폴더는 링크·정션을 거부하고, zip 은 풀기 전에 선언 크기·개수를, 푼 뒤 실제 크기를 본다
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { SKILL_LIMITS } from "@proprix/shared";
import { unzipSync } from "fflate";
import { normalizePath, SkillError, type SkillFile } from "./package";

export interface SourceFiles {
  folderName?: string; // 꾸러미의 폴더 이름 (SKILL.md 의 name 과 맞춰 본다)
  files: SkillFile[];
  skipped: string[];
}

const tooMany = () => new SkillError(`파일이 ${SKILL_LIMITS.files}개를 넘습니다`);
const tooBig = () => new SkillError("전체 크기가 20MB 를 넘습니다");

/** 로컬 폴더 (사용자가 고른 경로). 그 폴더가 skill 폴더다 */
export function readFolder(path: string): SourceFiles {
  if (!isAbsolute(path) || path.startsWith("\\\\")) throw new SkillError("로컬 폴더의 전체 경로를 넣으세요");
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    throw new SkillError("없는 폴더입니다");
  }
  if (st.isSymbolicLink()) throw new SkillError("링크·정션 폴더는 가져올 수 없습니다");
  if (!st.isDirectory()) throw new SkillError("폴더가 아닙니다");
  const files: SkillFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      // 링크·정션은 폴더 밖을 가리킬 수 있다 → 건너뛰지 않고 거부한다 (사용자가 알게)
      if (lstatSync(abs).isSymbolicLink()) throw new SkillError(`링크·정션은 가져올 수 없습니다: ${childRel}`);
      const norm = normalizePath(childRel);
      if (norm === null) {
        skipped.push(childRel);
        continue;
      }
      if (e.isDirectory()) walk(abs, childRel);
      else if (e.isFile()) {
        if (files.length >= SKILL_LIMITS.files) throw tooMany();
        total += statSync(abs).size;
        if (total > SKILL_LIMITS.totalBytes) throw tooBig();
        files.push({ path: norm, data: readFileSync(abs) });
      } else throw new SkillError(`일반 파일이 아닙니다: ${childRel}`);
    }
  };
  walk(path, "");
  return { folderName: basename(path), files, skipped };
}

/** zip 파일. SKILL.md 가 맨 위에 없고 모든 파일이 한 폴더 안이면 그 폴더를 skill 폴더로 본다 */
export function readZip(data: Uint8Array): SourceFiles {
  if (data.length > SKILL_LIMITS.totalBytes) throw tooBig();
  let declared = 0;
  let count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      // 풀기 전에 선언된 크기·개수로 거른다 (압축 폭탄)
      filter: (f) => {
        if (f.name.endsWith("/")) return false;
        count++;
        declared += f.originalSize;
        if (count > SKILL_LIMITS.files * 2) throw tooMany();
        if (declared > SKILL_LIMITS.totalBytes) throw tooBig();
        return true;
      },
    });
  } catch (e) {
    if (e instanceof SkillError) throw e;
    throw new SkillError("zip 파일을 읽을 수 없습니다");
  }
  const files: SkillFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    const norm = normalizePath(name);
    if (norm === null) {
      skipped.push(name);
      continue;
    }
    total += bytes.length;
    if (total > SKILL_LIMITS.totalBytes) throw tooBig();
    files.push({ path: norm, data: bytes });
  }
  if (files.length > SKILL_LIMITS.files) throw tooMany();
  if (files.some((f) => f.path === "SKILL.md")) return { files, skipped };
  const tops = new Set(files.map((f) => f.path.split("/")[0]));
  const [top] = tops;
  if (tops.size !== 1 || top === undefined || !files.every((f) => f.path.includes("/"))) return { files, skipped };
  return {
    folderName: top,
    files: files.map((f) => ({ path: f.path.slice(top.length + 1), data: f.data })),
    skipped,
  };
}
