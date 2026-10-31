// Skill (P7c): 이 실행에서 쓸 수 있는 skill 만. 스크립트는 P7a 실행 정책 그대로 (방 명령 실행·늘 확인·출력은 오염)
import { statSync } from "node:fs";
import { commandKey } from "@proprix/shared";
import { z } from "zod";
import { scriptsOf } from "../../skills/package";
import type { SkillService } from "../../skills/service";
import { runProcess } from "../exec-policy";
import { readText } from "../files";
import { resolveInside, WorkspaceError } from "../workspace";
import { define, type LocalTool, nullable, obj, runPlace, type ToolContext } from "./define";

const SKILL_BODY_MAX = 24_000;
const SKILL_OUTPUT_MAX = 30_000;

export function skillTools(skills: SkillService): LocalTool[] {
  // 이 실행에서 쓸 수 있는 skill 의 정식 이름 (아니면 오류)
  const usable = (ctx: ToolContext, name: string): string => {
    const canonical = skills.canonical(name);
    if (!canonical || !(ctx.skills ?? []).some((s) => commandKey(s) === commandKey(canonical)))
      throw new WorkspaceError(`이 실행에서 쓸 수 없는 Skill 입니다: ${name}`);
    return canonical;
  };
  const name = { type: "string", description: "The skill name." };

  return [
    define({
      info: {
        name: "skill_load",
        title: "Skill 로드",
        description: "Load a skill's instructions (SKILL.md) and its file list. Call this before using a skill.",
        kind: "read",
        requires: "skill",
      },
      maxOutput: SKILL_OUTPUT_MAX,
      parameters: obj({ name }),
      args: z.object({ name: z.string().min(1).max(64) }),
      run: (a, ctx) => {
        const n = usable(ctx, a.name);
        const body = skills.body(n);
        const files = skills.fileList(n);
        return {
          name: n,
          instructions: body.slice(0, SKILL_BODY_MAX),
          ...(body.length > SKILL_BODY_MAX
            ? { truncated: true, note: "Read the rest with skill_read_file (path SKILL.md, by line offset)." }
            : {}),
          files: files.slice(0, 100),
          ...(files.length > 100 ? { more_files: files.length - 100 } : {}),
          scripts: scriptsOf(files).map((s) => ({ ...s, available: skills.runners.status(s.runner)?.ok ?? false })),
        };
      },
    }),
    define({
      info: {
        name: "skill_read_file",
        title: "Skill 파일 읽기",
        description: "Read a text file inside a skill folder (with line numbers).",
        kind: "read",
        requires: "skill",
      },
      maxOutput: SKILL_OUTPUT_MAX,
      parameters: obj({
        name,
        path: { type: "string", description: "Path relative to the skill folder." },
        offset: nullable("integer", "First line to read (1-based). null for 1."),
        limit: nullable("integer", "How many lines (max 2000). null for 400."),
      }),
      args: z.object({
        name: z.string().min(1).max(64),
        path: z.string().min(1).max(260),
        offset: z.number().int().min(1).nullable(),
        limit: z.number().int().min(1).max(2000).nullable(),
      }),
      run: (a, ctx) => readText(skills.workspace(usable(ctx, a.name)), a.path, a.offset ?? 1, a.limit ?? 400),
    }),
    define({
      info: {
        name: "skill_run_script",
        title: "Skill 스크립트 실행",
        description:
          "Run a script from a skill folder with its interpreter, in the workspace folder. Arguments are passed as an array (no shell). The user always approves it first.",
        kind: "write",
        requires: "skill",
        alwaysConfirm: true,
      },
      needsShell: true,
      taints: "external",
      parameters: obj({
        name,
        script: { type: "string", description: "Script path relative to the skill folder, e.g. scripts/run.py" },
        args: { type: "array", items: { type: "string" }, description: "Arguments for the script." },
        cwd: nullable("string", "Folder inside the workspace to run in. null for the workspace folder."),
        timeout_sec: nullable("integer", "Time limit in seconds (max 600). null for 60."),
      }),
      args: z.object({
        name: z.string().min(1).max(64),
        script: z.string().min(1).max(260),
        args: z.array(z.string().max(4000)).max(30),
        cwd: z.string().nullable(),
        timeout_sec: z.number().int().min(1).max(600).nullable(),
      }),
      prepare: (a, ctx) => {
        const n = usable(ctx, a.name);
        const w = ctx.workspace;
        if (!w?.shell) throw new WorkspaceError("이 채팅에서는 명령 실행이 꺼져 있습니다");
        const script = resolveInside(skills.folder(n), a.script);
        if (!script.exists || !statSync(script.abs).isFile())
          throw new WorkspaceError("Skill 폴더에 없는 스크립트입니다");
        const found = scriptsOf([{ path: script.rel }])[0];
        if (!found) throw new WorkspaceError("실행할 수 있는 스크립트가 아닙니다 (.py · .js · .ts · .ps1)");
        const run = skills.runners.command(found.runner, script.abs, a.args);
        if (!run)
          throw new WorkspaceError(
            `실행기(${found.runner})가 없거나 동작하지 않습니다 — 확장 화면의 Skill 탭에서 확인하세요`,
          );
        const { dir, timeout } = runPlace(w.root, a.cwd, a.timeout_sec);
        return {
          preview: [
            `skill: ${n}`,
            `스크립트: ${script.rel}`,
            `실행기: ${run.cmd[0]}`,
            `인자: ${a.args.length ? JSON.stringify(a.args) : "(없음)"}`,
            `위치: ${dir.rel || "."}`,
            `제한 시간: ${timeout / 1000}초`,
          ].join("\n"),
          state: { cmd: run.cmd, env: run.env, cwd: dir.abs, timeout },
        };
      },
      run: async (_a, ctx, s) => {
        if (!ctx.workspace?.shell) throw new WorkspaceError("이 채팅에서는 명령 실행이 꺼져 있습니다");
        return runProcess({ cmd: s.cmd, env: s.env, cwd: s.cwd, timeoutMs: s.timeout, signal: ctx.signal });
      },
    }),
  ];
}
