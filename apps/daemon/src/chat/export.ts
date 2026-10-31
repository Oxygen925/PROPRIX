// 방 하나를 마크다운으로 내보내기 (날짜 구분 · 화자 · 시각 · 첨부 이름)
import type { Message, Room } from "@proprix/shared";

const pad = (n: number) => String(n).padStart(2, "0");
const day = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const time = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function roomMarkdown(
  room: Room,
  messages: Message[],
  nameOf: (agentId: string) => string,
  now = Date.now(),
): string {
  const out = [
    `# ${room.title}`,
    "",
    `- 참여: ${room.agentIds.map(nameOf).join(", ") || "없음"}`,
    `- 내보낸 시각: ${day(now)} ${time(now)}`,
  ];
  let lastDay = "";
  for (const m of messages) {
    if (m.status === "streaming" || (!m.content.trim() && m.attachments.length === 0)) continue;
    const d = day(m.createdAt);
    if (d !== lastDay) {
      out.push("", `## ${d}`);
      lastDay = d;
    }
    const who = m.role === "user" ? "나" : nameOf(m.agentId);
    out.push("", `**${who}** · ${time(m.createdAt)}${m.status === "complete" ? "" : " (일부)"}`, "");
    if (m.content.trim()) out.push(m.content.trim());
    for (const a of m.attachments) out.push(`> 첨부: ${a.name}`);
    for (const s of m.sources) out.push(`> 출처: [${s.title}](${s.url})`);
  }
  return `${out.join("\n")}\n`;
}
