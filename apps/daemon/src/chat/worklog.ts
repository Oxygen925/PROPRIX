// /debate·/collab: 토론을 연 대화에서 그동안 한 도구 작업을 짧게 적어 모든 참가자에게 넘긴다 (사용자 결정 2026-10-29).
// 인자·결과는 앞부분만 (fs_write 의 content 처럼 긴 값은 길이만). 최근 것부터 상한까지 담고, 오래된 것부터 보인다
import { cutLine, summarizeArgs, type ToolCall } from "@proprix/shared";
import { formatLocal } from "../proactive/time";

const MAX_CALLS = 30;
const MAX_TOTAL = 6000;
const OUTPUT_MAX = 300;
// 작업자 묶음은 작업자 행(worker)이 각자 결과를 갖고 있어 겹친다
const SKIP = new Set(["run_workers"]);

export function workLog(calls: readonly ToolCall[], agentName: (id: string) => string): string {
  const lines: string[] = [];
  let total = 0;
  const done = calls.filter((c) => c.status !== "pending" && c.status !== "running" && !SKIP.has(c.name));
  for (const c of done.slice(-MAX_CALLS).reverse()) {
    const result = c.status === "done" ? cutLine(c.output, OUTPUT_MAX) : cutLine(c.reason || c.output, OUTPUT_MAX);
    const line =
      `- ${formatLocal(c.createdAt)} ${agentName(c.agentId)}${c.parentId ? " (inside a delegation or worker)" : ""}: ` +
      `${c.name}(${summarizeArgs(c.args)}) → ${c.status}${result ? `: ${result}` : ""}`;
    if (total + line.length > MAX_TOTAL) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.reverse().join("\n");
}
