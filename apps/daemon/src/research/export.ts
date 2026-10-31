// 리서치 하나를 마크다운으로 내보내기: 결과 글과 이어서 나눈 대화를 시간순으로
import type { Research } from "@proprix/shared";
import type { ResearchStore } from "./store";

export function researchMarkdown(
  r: Research,
  t: ReturnType<ResearchStore["timeline"]>,
  agentName: (agentId: string) => string | undefined,
): string {
  const name = (a: string) => agentName(a) ?? "(삭제한 에이전트)";
  const parts = [
    ...t.runs
      .filter((x) => x.result)
      .map((x) => ({
        at: x.finishedAt ?? x.startedAt,
        text: `## ${name(x.agentId)}${x.role === "merge" ? " · 합친 글" : ""}\n\n${x.result}`,
      })),
    ...t.messages.map((x) => ({
      at: x.at,
      text: `**${x.role === "user" ? "나" : name(x.agentId)}**\n\n${x.text}`,
    })),
  ].toSorted((a, b) => a.at - b.at);
  return `# ${r.title}\n\n${r.goal}\n\n${parts.map((p) => p.text).join("\n\n---\n\n")}\n`;
}
