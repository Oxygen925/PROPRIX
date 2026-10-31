// 저장하지 않은 페르소나·역할로 한 번 대화해 본다. 이력·요약·메모리 없이 한 턴만 (쿼터를 쓰므로 LlmGate 를 거친다)
import type { PreviewRequest, PreviewResponse } from "@proprix/shared";
import type { z } from "zod";
import { buildInstructions } from "../context/instructions";
import type { LlmBackend } from "../context/llm-backend";
import type { LlmGate } from "../llm/gate";

const PREVIEW_TIMEOUT_MS = 120_000;

export async function runPreview(
  llm: LlmBackend,
  gate: LlmGate,
  req: z.infer<typeof PreviewRequest>,
): Promise<z.infer<typeof PreviewResponse>> {
  let text = "";
  const instructions = buildInstructions({
    agentName: req.name,
    role: req.role,
    persona: req.persona.body,
    summary: "",
  });
  const r = await gate.run("preview", req.model, () =>
    llm.stream(
      { model: req.model, instructions, turns: [{ role: "user", text: req.text }] },
      { onDelta: (d) => (text += d), totalMs: PREVIEW_TIMEOUT_MS },
    ),
  );
  return { text, outcome: r.outcome, code: r.code, recovery: r.recovery };
}
