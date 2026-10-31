// Skill: 경로·꾸러미 검증, zip·폴더 원본, 설치·업데이트 diff·삭제, 이름 공간, 실행기 없음
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, CommandInput, commandKey } from "@proprix/shared";
import { strToU8, zipSync } from "fflate";
import { AgentStore, DEFAULT_PERSONA_ID } from "../agents/store";
import { CommandStore } from "../commands/store";
import { migrate } from "../storage/db";
import { checkPackage, normalizePath, parseFrontmatter, SkillError, type SkillFile } from "./package";
import { Runners } from "./runners";
import { SkillService } from "./service";
import { readFolder, readZip } from "./sources";

let base: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "proprix-skill-"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const md = (name: string, description = "테스트 skill", body = "할 일") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const file = (path: string, text: string): SkillFile => ({ path, data: strToU8(text) });
const b64 = (files: Record<string, string>) =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))).toString("base64");

test("경로: 절대·드라이브·..·ADS·예약 이름·끝 점은 거부, 숨김·__MACOSX 는 건너뜀", () => {
  for (const bad of ["/etc/x", "C:/x", "a/../b", "a/./b", "a.txt:s", "CON.txt", "a./b", "a//b"])
    expect(() => normalizePath(bad)).toThrow(SkillError);
  expect(normalizePath("scripts\\run.py")).toBe("scripts/run.py");
  expect(normalizePath("__MACOSX/x")).toBeNull();
  expect(normalizePath(".git/config")).toBeNull();
  expect(normalizePath("a/.DS_Store")).toBeNull();
  expect(() => normalizePath("1/2/3/4/5/6/7/8/9.md")).toThrow("깊이");
});

test("frontmatter: 따옴표·여러 줄·BOM", () => {
  const r = parseFrontmatter(
    '\uFEFF---\nname: pdf\ndescription: "PDF \\"양식\\" 채우기"\nnote: |\n  첫 줄\n  둘째 줄\n---\n본문',
  );
  expect(r.meta).toEqual({ name: "pdf", description: 'PDF "양식" 채우기', note: "첫 줄\n둘째 줄" });
  expect(r.body).toBe("본문");
});

test("꾸러미: SKILL.md·name·description 필수, 폴더 이름 일치, 실행 파일·모르는 종류·내장 이름·대소문자 겹침 거부", () => {
  const ok = checkPackage([file("SKILL.md", md("Report")), file("scripts/a.py", "print(1)")], [], "report");
  expect(ok).toMatchObject({ name: "Report", description: "테스트 skill", body: "할 일" });
  expect(() => checkPackage([file("README.md", "x")])).toThrow("SKILL.md");
  expect(() => checkPackage([file("SKILL.md", "---\nname: a\n---\n")])).toThrow("description");
  expect(() => checkPackage([file("SKILL.md", md("report"))], [], "other")).toThrow("폴더 이름");
  expect(() => checkPackage([file("SKILL.md", md("a")), file("bin/x.exe", "MZ")])).toThrow("실행 파일");
  expect(() => checkPackage([file("SKILL.md", md("a")), file("x.bat", "")])).toThrow("실행 파일");
  expect(() => checkPackage([file("SKILL.md", md("a")), file("x.zip", "")])).toThrow("받지 않는");
  expect(() => checkPackage([file("SKILL.md", md("help"))])).toThrow("내장");
  expect(() => checkPackage([file("SKILL.md", md("a")), file("A.md", ""), file("a.md", "")])).toThrow("두 번");
  const many = Array.from({ length: 201 }, (_, i) => file(`f${i}.txt`, ""));
  expect(() => checkPackage([file("SKILL.md", md("a")), ...many])).toThrow("200");
  expect(checkPackage([file("SKILL.md", md("a")), file("LICENSE", "MIT")]).files).toHaveLength(2);
});

test("zip: 한 폴더로 묶인 것은 그 폴더를 벗기고, zip-slip 은 거부", () => {
  const src = readZip(Buffer.from(b64({ "pdf/SKILL.md": md("pdf"), "pdf/scripts/f.py": "x" }), "base64"));
  expect(src.folderName).toBe("pdf");
  expect(src.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "scripts/f.py"]);
  expect(() => readZip(Buffer.from(b64({ "SKILL.md": md("a"), "../evil.txt": "x" }), "base64"))).toThrow(SkillError);
  expect(() => readZip(new Uint8Array([1, 2, 3]))).toThrow("zip");
});

test("폴더: 링크·정션은 거부", () => {
  const dir = join(base, "linked");
  mkdirSync(dir);
  writeFileSync(join(dir, "SKILL.md"), md("linked"));
  expect(readFolder(dir).files.map((f) => f.path)).toEqual(["SKILL.md"]);
  const outside = join(base, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(dir, "escape"), "junction");
  expect(() => readFolder(dir)).toThrow("링크");
  expect(() => readFolder("relative/path")).toThrow("전체 경로");
});

function setup() {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  const dir = mkdtempSync(join(base, "store-"));
  let changed = 0;
  // 실행기는 찾지 못하는 것으로 (PATH 에 무엇이 있든 같은 결과)
  const skills = new SkillService(db, dir, new Runners(() => null), () => changed++);
  const commands = new CommandStore(db);
  const agents = new AgentStore(db);
  skills.takenElsewhere = (key) => commands.nameTaken(key);
  commands.otherOwners.push((key) => skills.has(key));
  skills.onRemove = (key) => agents.removeSkill(key, commandKey);
  return { db, skills, commands, agents, changed: () => changed };
}

test("설치 → 업데이트(바뀐 파일·diff·지운 파일) → 직접 작성은 다른 파일 유지 → 삭제는 에이전트 목록에서도 뺀다", async () => {
  const s = setup();
  await s.skills.runners.check();
  const first = s.skills.stage({
    kind: "zip",
    fileName: "r.zip",
    data: b64({ "SKILL.md": md("Report", "보고서", "v1"), "scripts/a.py": "print(1)", "old.txt": "x" }),
  });
  expect(first).toMatchObject({ name: "Report", existing: false, removed: [] });
  expect(first.scripts).toEqual([{ path: "scripts/a.py", runner: "python", ok: false }]);
  expect(first.warnings.join()).toContain("실행기");
  const info = s.skills.commit(first.id);
  expect(info).toMatchObject({ name: "Report", files: 3, modified: false, source: "zip" });
  expect(() => s.skills.commit(first.id)).toThrow("미리보기"); // 한 번만

  const agent = s.agents.createAgent(
    AgentInput.parse({ personaId: DEFAULT_PERSONA_ID, name: "a", skills: ["report"] }),
  );

  const upd = s.skills.stage({
    kind: "zip",
    fileName: "r.zip",
    data: b64({ "SKILL.md": md("Report", "보고서", "v2"), "scripts/a.py": "print(1)" }),
  });
  expect(upd.existing).toBe(true);
  expect(upd.files.find((f) => f.path === "SKILL.md")?.status).toBe("changed");
  expect(upd.files.find((f) => f.path === "scripts/a.py")?.status).toBe("same");
  expect(upd.removed).toEqual(["old.txt"]);
  expect(upd.diffs[0]?.diff).toContain("+v2");
  s.skills.commit(upd.id);
  expect(s.skills.body("report")).toBe("v2");
  expect(
    s.skills
      .fileList("Report")
      .map((f) => f.path)
      .sort(),
  ).toEqual(["SKILL.md", "scripts/a.py"]);

  const manual = s.skills.stage({ kind: "manual", name: "Report", description: "새 설명", body: "v3" });
  expect(manual.removed).toEqual([]);
  s.skills.commit(manual.id);
  expect(s.skills.detail("REPORT")).toMatchObject({ description: "새 설명", body: "v3", files: 2 });

  // 설치 뒤 바뀌면 modified
  writeFileSync(join(s.skills.folder("report"), "SKILL.md"), md("Report", "x", "몰래"));
  expect(s.skills.list()[0]?.modified).toBe(true);

  expect(s.skills.remove("report")).toBe(true);
  expect(s.skills.list()).toEqual([]);
  expect(s.agents.agent(agent?.id ?? "")?.skills).toEqual([]);
});

test("이름 공간: / 명령과 skill 은 같은 이름을 쓸 수 없다", () => {
  const s = setup();
  s.commands.create(CommandInput.parse({ name: "deploy", template: "x" }));
  expect(() => s.skills.stage({ kind: "manual", name: "Deploy", description: "d", body: "b" })).toThrow("/ 명령");
  const st = s.skills.stage({ kind: "manual", name: "review", description: "d", body: "b" });
  s.skills.commit(st.id);
  expect(s.commands.create(CommandInput.parse({ name: "Review", template: "x" }))).toMatchObject({ error: "taken" });
});

test("실행기: 찾지 못하면 실행 명령을 만들지 않는다", async () => {
  const r = new Runners(() => null);
  const list = await r.check();
  expect(list.map((x) => [x.id, x.ok])).toEqual([
    ["python", false],
    ["bun", false],
    ["powershell", false],
  ]);
  expect(r.command("python", "a.py", [])).toBeNull();
});

test("한글이 든 BOM 없는 .ps1 은 BOM 을 붙여 설치하고 알린다 (이미 BOM 이 있거나 ASCII 만이면 그대로)", () => {
  const pkg = checkPackage([
    file("SKILL.md", md("ps")),
    file("a.ps1", 'Write-Output "안녕"'),
    file("b.ps1", 'Write-Output "hi"'),
    { path: "c.ps1", data: new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8('"안녕"')]) },
  ]);
  const byPath = new Map(pkg.files.map((f) => [f.path, f.data]));
  expect([...(byPath.get("a.ps1") ?? []).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(byPath.get("b.ps1")?.[0]).toBe(0x57);
  expect((byPath.get("c.ps1") ?? []).length).toBe(3 + strToU8('"안녕"').length);
  expect(pkg.notes).toHaveLength(1);
  expect(pkg.notes[0]).toContain("a.ps1");
});
