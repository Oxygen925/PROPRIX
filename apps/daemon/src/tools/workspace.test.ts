// 작업 폴더 보안 기준: 폴더 지정 검증, 경로 탈출, 파일별 정책, 승인 후 변경 감지(TOCTOU), 복구, 명령 실행 정책
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { migrate } from "../storage/db";
import { powershell, runProcess, scrubEnv } from "./exec-policy";
import {
  FileChangeStore,
  prepareDelete,
  prepareEdit,
  prepareWrite,
  readText,
  searchText,
  type Workspace,
} from "./files";
import {
  globToRegExp,
  protectedRules,
  resolveInside,
  validateWorkspaceRoot,
  WorkspaceError,
  WorkspacePolicy,
} from "./workspace";

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "proprix-ws-"));
  root = join(base, "project");
  outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "src", "a.txt"), "hello\nworld\n");
  writeFileSync(join(outside, "secret.txt"), "nope");
  symlinkSync(outside, join(root, "link"), "junction"); // 정션: 관리자 권한 없이 만들 수 있다
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ws = (rules = { deny: [] as string[], readonly: [] as string[] }, shell = false): Workspace => ({
  root,
  policy: new WorkspacePolicy(rules),
  shell,
});

describe("폴더 지정", () => {
  test("있는 일반 폴더는 실제 경로로", () => {
    expect(validateWorkspaceRoot(root, join(base, "data")).toLowerCase()).toBe(root.toLowerCase());
  });
  test("드라이브·홈·시스템·데이터 폴더·없는 폴더·상대·UNC 는 거부", () => {
    const bad = [
      parse(root).root,
      homedir(),
      process.env.SystemRoot ?? "C:\\Windows",
      join(base, "none"),
      "project",
      "\\\\server\\share",
    ];
    for (const p of bad) expect(() => validateWorkspaceRoot(p, join(base, "data"))).toThrow(WorkspaceError);
    // 데이터 폴더 안은 안 되고, 데이터 폴더를 품은 폴더는 되지만 그 안은 막힌다
    expect(() => validateWorkspaceRoot(join(root, "src"), root)).toThrow("데이터 폴더");
    expect(validateWorkspaceRoot(root, join(root, "data")).toLowerCase()).toBe(root.toLowerCase());
    const guard = protectedRules(root, [join(root, "data")]);
    expect(new WorkspacePolicy({ deny: guard, readonly: [] }).check("data/proprix.sqlite", "read")).not.toBeNull();
    expect(protectedRules(root, [outside])).toEqual([]);
  });
});

describe("경로 해석", () => {
  test("폴더 안 경로 (없는 파일도)", () => {
    expect(resolveInside(root, "src/a.txt")).toMatchObject({ rel: "src/a.txt", exists: true });
    expect(resolveInside(root, "src/new/b.txt")).toMatchObject({ rel: "src/new/b.txt", exists: false });
    expect(resolveInside(root, ".").rel).toBe("");
  });
  test("탈출·장치·ADS·예약 이름·긴 경로·정션은 거부", () => {
    const bad = [
      "../outside/secret.txt",
      join(outside, "secret.txt"),
      "link/secret.txt", // 정션이 폴더 밖을 가리킴
      "src/a.txt:hidden",
      "src/CON.txt",
      "src/secret.pem.", // Windows 가 끝 점을 떼어 secret.pem 으로 만든다
      "src/a.txt ",
      "\\\\?\\C:\\Windows",
      `src/${"x".repeat(300)}.txt`,
    ];
    for (const p of bad) expect(() => resolveInside(root, p)).toThrow(WorkspaceError);
  });
});

describe("파일별 정책", () => {
  const p = new WorkspacePolicy({ deny: ["private/**"], readonly: ["*.lock"] });
  test("기본 규칙: 비밀·키는 읽기도, .git·node_modules 는 쓰기만 막는다", () => {
    for (const f of [".env", "app/.env.local", "certs/server.pem", "id_rsa", ".ssh/config", "aws/credentials"])
      expect(p.check(f, "read")).not.toBeNull();
    expect(p.check(".git/config", "read")).toBeNull();
    expect(p.check(".git/config", "write")).not.toBeNull();
    expect(p.check("node_modules/x/index.js", "write")).not.toBeNull();
    expect(p.check("src/a.ts", "write")).toBeNull();
  });
  test("방 규칙과 파일 사실 (바이너리·읽기 전용·크기)", () => {
    expect(p.check("private/notes.md", "read")).not.toBeNull();
    expect(p.check("bun.lock", "read")).toBeNull();
    expect(p.check("bun.lock", "write")).not.toBeNull();
    expect(p.check("a.bin", "write", { binary: true })).not.toBeNull();
    expect(p.check("a.txt", "write", { readonlyAttr: true })).not.toBeNull();
    expect(p.check("big.txt", "write", { size: 6 * 1024 * 1024 })).not.toBeNull();
  });
  test("glob", () => {
    expect(globToRegExp("*.lock").test("deep/dir/bun.lock")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/x/a.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/x/y/a.ts")).toBe(true);
  });
});

describe("정확한 변경 승인과 복구", () => {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = OFF"); // 방 없이 기록만 본다
  migrate(db);
  let snap: string;
  beforeAll(() => {
    snap = mkdtempSync(join(tmpdir(), "proprix-snap-"));
  });
  afterAll(() => rmSync(snap, { recursive: true, force: true }));

  test("고치기: diff 미리보기 → 적용 → 되돌리기", () => {
    const store = new FileChangeStore(db, snap);
    const p = prepareEdit(ws(), "src/a.txt", "world", "there", false);
    expect(p.preview).toContain("-world");
    expect(p.preview).toContain("+there");
    const c = store.apply(ws(), p, "call1", "room1");
    expect(readFileSync(join(root, "src", "a.txt"), "utf8")).toBe("hello\nthere\n");
    expect(store.restore(c.id, false)).toBe("ok");
    expect(readFileSync(join(root, "src", "a.txt"), "utf8")).toBe("hello\nworld\n");
    expect(store.restore(c.id, false)).toBe("already");
  });

  test("승인 뒤 파일이 바뀌면 쓰지 않는다 (TOCTOU)", () => {
    const store = new FileChangeStore(db, snap);
    const p = prepareWrite(ws(), "src/a.txt", "replaced");
    writeFileSync(join(root, "src", "a.txt"), "hello\nworld\nchanged meanwhile\n");
    expect(() => store.apply(ws(), p, "call2", "room1")).toThrow("바뀌었습니다");
    expect(readFileSync(join(root, "src", "a.txt"), "utf8")).toContain("changed meanwhile");
    writeFileSync(join(root, "src", "a.txt"), "hello\nworld\n");
  });

  test("직접 저장: 새 파일은 바로, 있는 파일은 overwrite 로만, 정책은 그대로, 되돌릴 수 있다", () => {
    const store = new FileChangeStore(db, snap);
    const c = store.save(ws(), "out/결과.md", "# 결론", "artifact:m1", "room1");
    if (c === "exists") throw new Error("exists");
    expect(c.callId).toBe("artifact:m1");
    expect(readFileSync(join(root, "out", "결과.md"), "utf8")).toBe("# 결론");
    expect(store.save(ws(), "out/결과.md", "# 다시", "artifact:m2", "room1")).toBe("exists");
    const o = store.save(ws(), "out/결과.md", "# 다시", "artifact:m2", "room1", true);
    if (o === "exists") throw new Error("exists");
    expect(readFileSync(join(root, "out", "결과.md"), "utf8")).toBe("# 다시");
    expect(store.restore(o.id, false)).toBe("ok");
    expect(readFileSync(join(root, "out", "결과.md"), "utf8")).toBe("# 결론");
    expect(store.restore(c.id, false)).toBe("ok");
    expect(existsSync(join(root, "out", "결과.md"))).toBe(false);
    expect(() => store.save(ws(), ".env", "X=1", "artifact:m3", "room1")).toThrow(WorkspaceError);
    expect(() => store.save(ws(), "../escape.md", "x", "artifact:m3", "room1")).toThrow(WorkspaceError);
  });

  test("되돌리기 충돌: 그 뒤 또 바뀌면 force 없이는 conflict", () => {
    const store = new FileChangeStore(db, snap);
    const c = store.apply(ws(), prepareWrite(ws(), "src/a.txt", "v2"), "call3", "room1");
    writeFileSync(join(root, "src", "a.txt"), "v3 by user");
    expect(store.restore(c.id, false)).toBe("conflict");
    expect(store.restore(c.id, true)).toBe("ok");
    expect(readFileSync(join(root, "src", "a.txt"), "utf8")).toBe("hello\nworld\n");
    // 덮어쓴 사용자 내용(v3)도 보관됐다 → 그 되돌리기를 되돌리면 v3 가 돌아온다
    const undo = store.forRoom("room1").find((x) => x.callId === `restore:${c.id}`);
    expect(undo).toBeDefined();
    expect(store.restore(undo?.id ?? "", false)).toBe("ok");
    expect(readFileSync(join(root, "src", "a.txt"), "utf8")).toBe("v3 by user");
    writeFileSync(join(root, "src", "a.txt"), "hello\nworld\n");
  });

  test("새 파일 되돌리기는 지우고, 지우기는 보관함으로 옮겼다가 되돌린다", () => {
    const store = new FileChangeStore(db, snap);
    const made = store.apply(ws(), prepareWrite(ws(), "src/new.txt", "new"), "call4", "room1");
    expect(existsSync(join(root, "src", "new.txt"))).toBe(true);
    expect(store.restore(made.id, false)).toBe("ok");
    expect(existsSync(join(root, "src", "new.txt"))).toBe(false);
    const back = store.forRoom("room1").find((x) => x.callId === `restore:${made.id}`);
    expect(back?.op).toBe("delete"); // 그냥 지우지 않고 보관함으로 옮겼다

    const del = store.apply(ws(), prepareDelete(ws(), "src/a.txt"), "call5", "room1");
    expect(existsSync(join(root, "src", "a.txt"))).toBe(false);
    expect(store.usage().count).toBeGreaterThan(0);
    expect(store.restore(del.id, false)).toBe("ok");
    expect(readFileSync(join(root, "src", "a.txt"), "utf8")).toBe("hello\nworld\n");
  });

  test("정책에 막힌 파일·읽기 전용 파일은 준비 단계에서 거부", () => {
    writeFileSync(join(root, ".env"), "KEY=1");
    expect(() => prepareWrite(ws(), ".env", "x")).toThrow("비밀");
    writeFileSync(join(root, "ro.txt"), "ro");
    chmodSync(join(root, "ro.txt"), 0o444);
    expect(() => prepareWrite(ws(), "ro.txt", "x")).toThrow("읽기 전용");
    chmodSync(join(root, "ro.txt"), 0o666);
    expect(() => prepareWrite(ws({ deny: [], readonly: ["src/**"] }), "src/a.txt", "x")).toThrow("읽기 전용");
  });

  test("보관 기간이 지나면 원본을 지우고 되돌릴 수 없다", () => {
    let now = Date.now();
    const store = new FileChangeStore(db, snap, () => now);
    const c = store.apply(ws(), prepareWrite(ws(), "src/a.txt", "old"), "call6", "room1");
    now += 31 * 24 * 60 * 60 * 1000;
    store.prune();
    expect(store.restore(c.id, true)).toBe("missing_snapshot");
    writeFileSync(join(root, "src", "a.txt"), "hello\nworld\n");
  });
});

describe("글자·줄바꿈", () => {
  test("UTF-8 이 아닌 파일(CP949)은 읽거나 고치지 않는다", () => {
    writeFileSync(join(root, "cp949.txt"), Buffer.from([0xbe, 0xc8, 0xb3, 0xe7, 0x0a])); // "안녕" (CP949)
    expect(() => readText(ws(), "cp949.txt", 1, 10)).toThrow("UTF-8");
    expect(() => prepareEdit(ws(), "cp949.txt", "a", "b", false)).toThrow("UTF-8");
    expect(() => prepareWrite(ws(), "cp949.txt", "x")).toThrow("UTF-8");
  });
  test("BOM 은 지키고, CRLF 파일은 LF 로 준 여러 줄 고치기도 맞추며 쓰기도 CRLF 를 지킨다", () => {
    const db = new Database(":memory:", { strict: true });
    migrate(db);
    const store = new FileChangeStore(db, join(base, "snap-enc"));
    writeFileSync(join(root, "crlf.txt"), "\uFEFFfirst\r\nsecond\r\nthird\r\n");
    const edit = prepareEdit(ws(), "crlf.txt", "first\nsecond", "1\n2", false);
    expect(edit.preview).toContain("+1");
    store.apply(ws(), edit, "c", "r");
    expect(readFileSync(join(root, "crlf.txt"), "utf8")).toBe("\uFEFF1\r\n2\r\nthird\r\n");
    const write = prepareWrite(ws(), "crlf.txt", "a\nb\n");
    store.apply(ws(), write, "c2", "r");
    expect(readFileSync(join(root, "crlf.txt"), "utf8")).toBe("\uFEFFa\r\nb\r\n");
  });
  test("찾기: 겹친 반복 정규식은 거부, 긴 정규식 거부", () => {
    expect(() => searchText(ws(), "(a+)+$", ".", null, true)).toThrow("반복");
    expect(() => searchText(ws(), "x".repeat(201), ".", null, true)).toThrow("200");
    expect(searchText(ws(), "hello", ".", "*.txt", false).matches.length).toBeGreaterThan(0);
  });
});

describe("명령 실행 정책", () => {
  test("비밀 환경 변수는 넘기지 않는다", () => {
    const env = scrubEnv({ PATH: "x", PROPRIX_API_TOKEN: "t", GITHUB_TOKEN: "g", MY_API_KEY: "k", HOME: "h" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
  });
  test("출력·종료 코드, 제한 시간·중지", async () => {
    const ok = await runProcess({
      cmd: powershell("Write-Output 안녕; exit 3"),
      cwd: root,
    });
    expect(ok.stdout).toContain("안녕");
    expect(ok.exit_code).toBe(3);
    const slow = await runProcess({
      cmd: ["powershell.exe", "-NoProfile", "-Command", "Start-Sleep 20"],
      cwd: root,
      timeoutMs: 1000,
    });
    expect(slow.timed_out).toBe(true);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    const stopped = await runProcess({
      cmd: ["powershell.exe", "-NoProfile", "-Command", "Start-Sleep 20"],
      cwd: root,
      signal: ctrl.signal,
    });
    expect(stopped.cancelled).toBe(true);
    // 백그라운드에 남은 프로세스가 출력 핸들을 쥐고 있어도 끝난다
    const started = Date.now();
    const detached = await runProcess({
      cmd: powershell(
        "Start-Process -NoNewWindow powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 15'; Write-Output done",
      ),
      cwd: tmpdir(), // 남은 프로세스가 폴더를 잡고 있어 지우지 못하는 일이 없게
    });
    expect(detached.stdout).toContain("done");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});
