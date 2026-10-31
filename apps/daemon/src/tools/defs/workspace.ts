// 작업 폴더 (P7a)
import { z } from "zod";
import { powershell, runProcess } from "../exec-policy";
import {
  type FileChangeStore,
  listFiles,
  type PreparedChange,
  prepareDelete,
  prepareEdit,
  prepareWrite,
  readText,
  searchText,
  type Workspace,
} from "../files";
import { WorkspaceError } from "../workspace";
import { define, type LocalTool, nullable, obj, runPlace, type ToolContext } from "./define";

const ws = (ctx: ToolContext): Workspace => {
  if (!ctx.workspace) throw new WorkspaceError("이 채팅에는 작업 폴더가 없습니다");
  return ctx.workspace;
};
const path = { type: "string", description: "Path relative to the workspace folder ('.' = the folder itself)." };

export function workspaceTools(changes: FileChangeStore): LocalTool[] {
  // 쓰기: 승인 전에 diff·해시를 확정하고, 승인 뒤 파일이 그대로일 때만 그 내용을 쓴다
  const apply = (ctx: ToolContext, p: PreparedChange) => {
    const c = changes.apply(ws(ctx), p, ctx.callId ?? "", ctx.roomId);
    return { ok: true, path: c.path, op: c.op, change_id: c.id };
  };

  return [
    define({
      info: {
        name: "fs_list",
        title: "파일 목록",
        description: "List files and folders in the workspace.",
        kind: "read",
        requires: "workspace",
        alwaysConfirm: false,
      },
      parameters: obj({ path, depth: nullable("integer", "How many folder levels to show (1-3). null for 1.") }),
      args: z.object({ path: z.string(), depth: z.number().int().min(1).max(3).nullable() }),
      taints: "workspace",
      run: (a, ctx) => listFiles(ws(ctx), a.path, a.depth ?? 1),
    }),
    define({
      info: {
        name: "fs_read",
        title: "파일 읽기",
        description: "Read a text file in the workspace (with line numbers).",
        kind: "read",
        requires: "workspace",
        alwaysConfirm: false,
      },
      parameters: obj({
        path,
        offset: nullable("integer", "First line to read (1-based). null for 1."),
        limit: nullable("integer", "How many lines (max 2000). null for 400."),
      }),
      args: z.object({
        path: z.string(),
        offset: z.number().int().min(1).nullable(),
        limit: z.number().int().min(1).max(2000).nullable(),
      }),
      taints: "workspace",
      run: (a, ctx) => readText(ws(ctx), a.path, a.offset ?? 1, a.limit ?? 400),
    }),
    define({
      info: {
        name: "fs_search",
        title: "파일 검색",
        description: "Search text in workspace files.",
        kind: "read",
        requires: "workspace",
        alwaysConfirm: false,
      },
      parameters: obj({
        query: { type: "string" },
        path: nullable("string", "Folder to search in. null for the whole workspace."),
        glob: nullable("string", "File name filter like *.ts. null for all files."),
        regex: nullable("boolean", "Treat query as a regular expression. null for plain text."),
      }),
      args: z.object({
        query: z.string().min(1).max(500),
        path: z.string().nullable(),
        glob: z.string().max(100).nullable(),
        regex: z.boolean().nullable(),
      }),
      taints: "workspace",
      run: (a, ctx) => searchText(ws(ctx), a.query, a.path ?? ".", a.glob, a.regex ?? false),
    }),

    define({
      info: {
        name: "fs_write",
        title: "파일 쓰기",
        description: "Create a file or replace its whole content in the workspace.",
        kind: "write",
        requires: "workspace",
        alwaysConfirm: false,
      },
      parameters: obj({ path, content: { type: "string", description: "The complete new file content." } }),
      args: z.object({ path: z.string().min(1), content: z.string() }),
      prepare: (a, ctx) => {
        const p = prepareWrite(ws(ctx), a.path, a.content);
        return { preview: p.preview, state: p };
      },
      run: (_a, ctx, p) => apply(ctx, p),
    }),
    define({
      info: {
        name: "fs_edit",
        title: "파일 편집",
        description: "Replace exact text in a workspace file. old_string must match exactly (whitespace included).",
        kind: "write",
        requires: "workspace",
        alwaysConfirm: false,
      },
      parameters: obj({
        path,
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: nullable("boolean", "Replace every occurrence. null for false (old_string must then be unique)."),
      }),
      args: z.object({
        path: z.string().min(1),
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().nullable(),
      }),
      prepare: (a, ctx) => {
        const p = prepareEdit(ws(ctx), a.path, a.old_string, a.new_string, a.replace_all ?? false);
        return { preview: p.preview, state: p };
      },
      run: (_a, ctx, p) => apply(ctx, p),
    }),
    define({
      info: {
        name: "fs_delete",
        title: "파일 삭제",
        description: "Delete a file in the workspace (it can be restored by the user).",
        kind: "write",
        requires: "workspace",
        alwaysConfirm: false,
      },
      parameters: obj({ path }),
      args: z.object({ path: z.string().min(1) }),
      prepare: (a, ctx) => {
        const p = prepareDelete(ws(ctx), a.path);
        return { preview: p.preview, state: p };
      },
      run: (_a, ctx, p) => apply(ctx, p),
    }),

    // 명령 실행: 방에서 켰을 때만, 늘 확인, 출력은 신뢰하지 않는 데이터
    define({
      info: {
        name: "shell_run",
        title: "명령 실행",
        description: "Run a PowerShell command in the workspace folder. The user always approves it first.",
        kind: "write",
        requires: "shell",
        alwaysConfirm: true,
      },
      parameters: obj({
        command: { type: "string", description: "A PowerShell command." },
        cwd: nullable("string", "Folder inside the workspace to run in. null for the workspace folder."),
        timeout_sec: nullable("integer", "Time limit in seconds (max 600). null for 60."),
      }),
      args: z.object({
        command: z.string().min(1).max(8000),
        cwd: z.string().nullable(),
        timeout_sec: z.number().int().min(1).max(600).nullable(),
      }),
      taints: "external",
      prepare: (a, ctx) => {
        const w = ws(ctx);
        if (!w.shell) throw new WorkspaceError("이 채팅에서는 명령 실행이 꺼져 있습니다");
        const { dir, timeout } = runPlace(w.root, a.cwd, a.timeout_sec);
        return {
          preview: `위치: ${dir.rel || "."}\n제한 시간: ${timeout / 1000}초\n\n${a.command}`,
          state: { cwd: dir.abs, timeout },
        };
      },
      run: async (a, ctx, s) => {
        if (!ws(ctx).shell) throw new WorkspaceError("이 채팅에서는 명령 실행이 꺼져 있습니다");
        return runProcess({ cmd: powershell(a.command), cwd: s.cwd, timeoutMs: s.timeout, signal: ctx.signal });
      },
    }),
  ];
}
