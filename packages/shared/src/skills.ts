// Skill (P7c): SKILL.md 폴더. 가져오기는 검증 → 미리보기(바뀐 파일·스크립트·실행기) → 확인 → 설치 순서
import { z } from "zod";

export const SKILL_LIMITS = {
  files: 200,
  totalBytes: 20 * 1024 * 1024,
  skillMdBytes: 1024 * 1024,
  depth: 8,
  description: 1024,
} as const;

export const RunnerId = z.enum(["python", "bun", "powershell"]);
export type RunnerId = z.infer<typeof RunnerId>;
// 스크립트 확장자 → 실행기
export const SCRIPT_RUNNERS: Record<string, RunnerId> = {
  py: "python",
  js: "bun",
  mjs: "bun",
  cjs: "bun",
  ts: "bun",
  ps1: "powershell",
};

export const RunnerStatus = z.object({
  id: RunnerId,
  label: z.string(),
  exts: z.array(z.string()),
  path: z.string(), // 찾은 실행 파일 절대 경로 ("" = 없음)
  version: z.string(),
  ok: z.boolean(),
  error: z.string(),
});
export type RunnerStatus = z.infer<typeof RunnerStatus>;

export const SkillScript = z.object({ path: z.string(), runner: RunnerId, ok: z.boolean() });
export type SkillScript = z.infer<typeof SkillScript>;

export const SkillInfo = z.object({
  name: z.string(),
  description: z.string(),
  source: z.string(), // folder · zip · manual
  files: z.number(),
  size: z.number(),
  scripts: z.array(SkillScript),
  modified: z.boolean(), // 설치한 뒤 폴더 내용이 바뀜 (해시가 다름)
  installedAt: z.number(),
  updatedAt: z.number(),
});
export type SkillInfo = z.infer<typeof SkillInfo>;
export const SkillDetail = SkillInfo.extend({
  body: z.string(), // SKILL.md 본문 (frontmatter 뺌)
  fileList: z.array(z.object({ path: z.string(), size: z.number() })),
});
export type SkillDetail = z.infer<typeof SkillDetail>;

export const SkillImportRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("folder"), path: z.string().min(1).max(260) }),
  // zip 파일 내용 (base64)
  z.object({ kind: z.literal("zip"), fileName: z.string().max(260), data: z.string().max(30_000_000) }),
  // 직접 작성: 있는 skill 이면 SKILL.md 만 바꾸고 다른 파일은 그대로
  z.object({
    kind: z.literal("manual"),
    name: z.string().trim().min(1).max(64),
    description: z.string().trim().min(1).max(SKILL_LIMITS.description),
    body: z.string().max(SKILL_LIMITS.skillMdBytes),
  }),
]);
export type SkillImportRequest = z.infer<typeof SkillImportRequest>;

// 가져오기 미리보기 (확인하면 설치)
export const SkillStage = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  existing: z.boolean(), // 같은 이름이 이미 있음 → 업데이트
  files: z.array(z.object({ path: z.string(), size: z.number(), status: z.enum(["added", "changed", "same"]) })),
  removed: z.array(z.string()),
  diffs: z.array(z.object({ path: z.string(), diff: z.string() })), // 바뀐 글 파일의 diff (길면 잘림)
  scripts: z.array(SkillScript),
  skipped: z.array(z.string()), // 숨김 파일 등 건너뛴 것
  warnings: z.array(z.string()),
});
export type SkillStage = z.infer<typeof SkillStage>;
