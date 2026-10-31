// Skill 저장소: <dir>/<name_key>/ 에 설치하고 DB 에 이름·설명·해시를 둔다.
// 가져오기는 stage(검증·미리보기) → commit(설치) 두 단계. 이름은 / 명령과 한 이름 공간
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  commandKey,
  type SkillDetail,
  type SkillImportRequest,
  type SkillInfo,
  type SkillScript,
  type SkillStage,
} from "@proprix/shared";
import { createTwoFilesPatch } from "diff";
import type { Workspace } from "../tools/files";
import { WorkspacePolicy } from "../tools/workspace";
import {
  checkPackage,
  packageHash,
  parseFrontmatter,
  SkillError,
  type SkillFile,
  type SkillPackage,
  scriptsOf,
} from "./package";
import type { Runners } from "./runners";
import { readFolder, readZip } from "./sources";

interface SkillRow {
  name: string;
  name_key: string;
  description: string;
  hash: string;
  source: string;
  installed_at: number;
  updated_at: number;
}

interface Staged {
  pkg: SkillPackage;
  source: "folder" | "zip" | "manual";
  at: number;
}

const STAGE_TTL_MS = 15 * 60_000;
const STAGE_MAX = 5;
const DIFF_FILE_MAX = 200_000; // 이보다 큰 파일은 diff 를 만들지 않는다
const DIFF_TOTAL_MAX = 200_000;
const KNOWN_META = new Set(["name", "description"]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

const textOf = (data: Uint8Array): string | null => {
  if (data.length > DIFF_FILE_MAX || data.includes(0)) return null;
  try {
    return utf8.decode(data);
  } catch {
    return null;
  }
};

export class SkillService {
  // 이 이름(key)을 skill 밖(/ 명령)에서 쓰고 있나
  takenElsewhere: (key: string) => boolean = () => false;
  // 지운 skill 을 에이전트 목록에서 뺀다
  onRemove: (key: string) => void = () => {};
  private staged = new Map<string, Staged>();

  constructor(
    private readonly db: Database,
    readonly dir: string,
    readonly runners: Runners,
    private readonly onChange: () => void = () => {},
  ) {}

  private row(name: string): SkillRow | null {
    return this.db
      .query<SkillRow, { key: string }>("SELECT * FROM skills WHERE name_key = $key")
      .get({ key: commandKey(name) });
  }

  /** 설치된 skill 의 정식 이름 (없으면 null) */
  canonical(name: string): string | null {
    return this.row(name)?.name ?? null;
  }

  has(key: string): boolean {
    return this.db.query("SELECT 1 FROM skills WHERE name_key = $key").get({ key }) !== null;
  }

  folder(name: string): string {
    return join(this.dir, commandKey(name));
  }

  // ---- 조회 ----

  private diskFiles(name: string): SkillFile[] {
    const root = this.folder(name);
    const out: SkillFile[] = [];
    const walk = (dir: string, rel: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), childRel);
        else if (e.isFile()) out.push({ path: childRel, data: readFileSync(join(dir, e.name)) });
      }
    };
    walk(root, "");
    return out;
  }

  private scripts(files: { path: string }[]): SkillScript[] {
    return scriptsOf(files).map((s) => ({ ...s, ok: this.runners.status(s.runner)?.ok ?? false }));
  }

  private info(r: SkillRow, files = this.diskFiles(r.name)): SkillInfo {
    return {
      name: r.name,
      description: r.description,
      source: r.source,
      files: files.length,
      size: files.reduce((n, f) => n + f.data.length, 0),
      scripts: this.scripts(files),
      modified: packageHash(files) !== r.hash,
      installedAt: r.installed_at,
      updatedAt: r.updated_at,
    };
  }

  list(): SkillInfo[] {
    return this.db
      .query<SkillRow, []>("SELECT * FROM skills ORDER BY name_key")
      .all()
      .map((r) => this.info(r));
  }

  detail(name: string): SkillDetail | null {
    const r = this.row(name);
    if (!r) return null;
    const files = this.diskFiles(r.name);
    const md = files.find((f) => f.path === "SKILL.md");
    return {
      ...this.info(r, files),
      body: md ? parseFrontmatter(new TextDecoder().decode(md.data)).body.trim() : "",
      fileList: files.map((f) => ({ path: f.path, size: f.data.length })).sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  /** 도구가 skill 폴더를 읽을 때 쓰는 작업 폴더 (읽기만, 기본 규칙 적용) */
  workspace(name: string): Workspace {
    return { root: this.folder(name), policy: new WorkspacePolicy(), shell: false };
  }

  // ---- 가져오기 ----

  stage(req: SkillImportRequest): SkillStage {
    const { pkg, source } = this.build(req);
    const existing = this.row(pkg.name);
    if (!existing && this.takenElsewhere(commandKey(pkg.name)))
      throw new SkillError(`/${pkg.name} 은(는) 이미 있는 / 명령어 이름입니다. SKILL.md 의 name 을 바꾸세요`);
    const old = new Map(existing ? this.diskFiles(existing.name).map((f) => [f.path, f.data]) : []);

    const diffs: SkillStage["diffs"] = [];
    let diffTotal = 0;
    const files = pkg.files
      .map((f) => {
        const before = old.get(f.path);
        const status: "added" | "changed" | "same" = !before
          ? "added"
          : Buffer.compare(Buffer.from(before), Buffer.from(f.data)) === 0
            ? "same"
            : "changed";
        if (status === "changed" && before) {
          const a = textOf(before);
          const b = textOf(f.data);
          const diff =
            a === null || b === null
              ? "(바이너리이거나 너무 커서 diff 를 보이지 않음)"
              : a === b
                ? "(글자는 같고 BOM·인코딩만 다름)"
                : createTwoFilesPatch(f.path, f.path, a, b, "", "", { context: 3 });
          if (diffTotal + diff.length <= DIFF_TOTAL_MAX) {
            diffs.push({ path: f.path, diff });
            diffTotal += diff.length;
          } else diffs.push({ path: f.path, diff: "(diff 가 너무 길어 생략)" });
        }
        return { path: f.path, size: f.data.length, status };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    const kept = new Set(pkg.files.map((f) => f.path));
    const removed = [...old.keys()].filter((p) => !kept.has(p)).sort();

    const scripts = this.scripts(pkg.files);
    const warnings: string[] = [...pkg.notes];
    for (const s of scripts) if (!s.ok) warnings.push(`${s.path}: 실행기(${s.runner})가 없어 실행할 수 없습니다`);
    const md = pkg.files.find((f) => f.path === "SKILL.md");
    const extra = md
      ? Object.keys(parseFrontmatter(new TextDecoder().decode(md.data)).meta).filter((k) => !KNOWN_META.has(k))
      : [];
    if (extra.length) warnings.push(`SKILL.md 의 ${extra.join(", ")} 항목은 쓰지 않습니다 (name·description 만)`);
    if (existing && existing.name !== pkg.name) warnings.push(`이름이 ${existing.name} → ${pkg.name} 로 바뀝니다`);

    const id = crypto.randomUUID();
    this.prune();
    this.staged.set(id, { pkg, source, at: Date.now() });
    return {
      id,
      name: pkg.name,
      description: pkg.description,
      existing: existing !== null,
      files,
      removed,
      diffs,
      scripts,
      skipped: pkg.skipped,
      warnings,
    };
  }

  private build(req: SkillImportRequest): { pkg: SkillPackage; source: Staged["source"] } {
    if (req.kind === "folder") {
      const src = readFolder(req.path);
      return { pkg: checkPackage(src.files, src.skipped, src.folderName), source: "folder" };
    }
    if (req.kind === "zip") {
      const src = readZip(Buffer.from(req.data, "base64"));
      return { pkg: checkPackage(src.files, src.skipped, src.folderName), source: "zip" };
    }
    // 직접 작성: SKILL.md 를 만들고, 있는 skill 이면 다른 파일은 그대로 둔다
    const md = `---\nname: ${req.name}\ndescription: ${JSON.stringify(req.description.replace(/\s+/g, " "))}\n---\n\n${req.body.trim()}\n`;
    const existing = this.row(req.name);
    const others = existing ? this.diskFiles(existing.name).filter((f) => f.path !== "SKILL.md") : [];
    return {
      pkg: checkPackage([{ path: "SKILL.md", data: new TextEncoder().encode(md) }, ...others]),
      source: "manual",
    };
  }

  private prune() {
    const now = Date.now();
    for (const [id, s] of this.staged) if (now - s.at > STAGE_TTL_MS) this.staged.delete(id);
    while (this.staged.size >= STAGE_MAX) this.staged.delete(this.staged.keys().next().value as string);
  }

  discard(id: string) {
    this.staged.delete(id);
  }

  /** 미리보기한 그대로 설치한다 (새 폴더에 다 쓴 뒤 바꿔 끼운다) */
  commit(id: string): SkillInfo {
    const s = this.staged.get(id);
    if (!s || Date.now() - s.at > STAGE_TTL_MS) throw new SkillError("미리보기가 끝났습니다. 다시 가져오세요");
    this.staged.delete(id);
    const { pkg } = s;
    const key = commandKey(pkg.name);
    const existing = this.row(pkg.name);
    if (!existing && this.takenElsewhere(key))
      throw new SkillError(`/${pkg.name} 은(는) 이미 있는 / 명령어 이름입니다`);

    mkdirSync(this.dir, { recursive: true });
    const target = join(this.dir, key);
    const tmp = join(this.dir, `.staging-${id}`);
    const old = join(this.dir, `.old-${id}`);
    try {
      for (const f of pkg.files) {
        const abs = join(tmp, ...f.path.split("/"));
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.data);
      }
      if (existsSync(target)) renameSync(target, old);
      renameSync(tmp, target);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      if (existsSync(old) && !existsSync(target)) renameSync(old, target);
      throw e;
    }
    rmSync(old, { recursive: true, force: true });

    const params = {
      name: pkg.name,
      key,
      description: pkg.description,
      hash: pkg.hash,
      source: s.source,
      now: Date.now(),
    };
    if (existing)
      this.db
        .query(
          `UPDATE skills SET name = $name, description = $description, hash = $hash, source = $source,
           updated_at = $now WHERE name_key = $key`,
        )
        .run(params);
    else
      this.db
        .query(
          `INSERT INTO skills (name, name_key, description, hash, source, installed_at, updated_at)
           VALUES ($name, $key, $description, $hash, $source, $now, $now)`,
        )
        .run(params);
    this.onChange();
    return this.info(this.row(pkg.name) as SkillRow);
  }

  remove(name: string): boolean {
    const r = this.row(name);
    if (!r) return false;
    this.db.query("DELETE FROM skills WHERE name_key = $key").run({ key: r.name_key });
    rmSync(this.folder(r.name), { recursive: true, force: true });
    this.onRemove(r.name_key);
    this.onChange();
    return true;
  }

  // ---- 런타임 (도구·instructions) ----

  /** SKILL.md 본문 (frontmatter 뺌) */
  body(name: string): string {
    const abs = join(this.folder(name), "SKILL.md");
    return existsSync(abs) ? parseFrontmatter(readFileSync(abs, "utf8")).body.trim() : "";
  }

  describe(name: string): { name: string; description: string } | null {
    const r = this.row(name);
    return r ? { name: r.name, description: r.description } : null;
  }

  fileList(name: string): { path: string; size: number }[] {
    return this.diskFiles(name).map((f) => ({ path: f.path, size: f.data.length }));
  }

  isFile(name: string, rel: string): boolean {
    const abs = join(this.folder(name), ...rel.split("/"));
    return existsSync(abs) && statSync(abs).isFile();
  }
}

export { SkillError };
