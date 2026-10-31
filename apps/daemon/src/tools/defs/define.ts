// 도구 정의의 공통 모양: registry 와 defs/* 가 함께 쓴다
import { statSync } from "node:fs";
import type { Agent, ToolInfo } from "@proprix/shared";
import type { z } from "zod";
import { DEFAULT_TIMEOUT_MS } from "../exec-policy";
import type { Workspace } from "../files";
import { resolveInside, WorkspaceError } from "../workspace";

export interface ToolContext {
  agent: Agent;
  roomId: string;
  workspace?: Workspace; // 방의 작업 폴더 (없으면 파일·명령 도구가 보이지 않는다)
  callId?: string; // 실행할 때 (복구 기록에 묶는다)
  outside?: boolean; // 이 턴에 웹 검색·MCP·명령 출력 같은 바깥 데이터가 들어왔다 (시각화는 눌러야 보인다)
  messageId?: string; // 지금 쓰는 답 (memory_save 의 출처 메시지)
  signal?: AbortSignal; // 중지
  skills?: string[]; // 이 실행에서 쓸 수 있는 skill (에이전트가 켠 것 + 사용자가 /이름 으로 부른 것)
}

export interface LocalTool {
  info: ToolInfo;
  // strict 스키마: 모든 속성을 required 로, 선택값은 null 허용 타입으로
  parameters: Record<string, unknown>;
  args: z.ZodType;
  run(args: never, ctx: ToolContext, prepared?: never): unknown;
  // 승인 전에 할 일을 확정하고 카드에 보일 미리보기를 만든다 (파일 쓰기·명령). 결과는 run 에 그대로 넘어간다
  prepare?(args: never, ctx: ToolContext): { preview: string; state: unknown };
  // 결과가 신뢰할 수 없는 데이터 → 그 턴의 쓰기를 다시 확인
  // external: 명령 출력 등 → 모든 쓰기 / workspace: 작업 폴더 파일 내용 → 폴더 밖으로 이어지는 쓰기(기억·리마인더 등)만
  taints?: "external" | "workspace";
  // 쓰기지만 확인 없이 실행 (바깥에 남는 변화가 작고 되돌리기 쉬움). 웹 검색·토론이 끼어든 턴에서는 그래도 확인
  trusted?: boolean;
  // 방에서 직접 말하는 에이전트만 (위임 받은 실행에서는 숨김 — 리마인더가 방에 없는 에이전트로 울리지 않게)
  topLevelOnly?: boolean;
  needsShell?: boolean; // requires 'skill' 이면서 방의 명령 실행도 켜져 있어야 함
  maxOutput?: number; // 결과 글자 상한 (기본 MAX_TOOL_OUTPUT)
  // 호출할 때마다 바뀌는 설명 (예: 지금 시각)
  describe?: () => string;
}

// 인자 타입을 스키마에서, 준비 결과 타입을 prepare 에서 이어받는다 (prepare 를 run 앞에 쓴다)
export const define = <T extends z.ZodType, S = never>(
  t: Omit<LocalTool, "args" | "run" | "prepare"> & {
    args: T;
    prepare?(a: z.infer<T>, ctx: ToolContext): { preview: string; state: S };
    run(a: z.infer<T>, ctx: ToolContext, prepared: S): unknown;
  },
) => t as unknown as LocalTool;

export const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const nullable = (type: string, description: string) => ({ type: [type, "null"], description });

// 모델이 고쳐 다시 부를 수 있는 입력 문제 (호출은 실패로 남고 메시지가 모델에게 간다)
export class ToolInputError extends Error {}

// 명령을 돌릴 폴더와 제한 시간 (작업 폴더 안의 있는 폴더만)
export function runPlace(root: string, cwd: string | null, timeoutSec: number | null) {
  const dir = resolveInside(root, cwd ?? ".");
  if (!dir.exists || !statSync(dir.abs).isDirectory()) throw new WorkspaceError("없는 폴더입니다");
  return { dir, timeout: (timeoutSec ?? DEFAULT_TIMEOUT_MS / 1000) * 1000 };
}
