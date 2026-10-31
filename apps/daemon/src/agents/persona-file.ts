// 페르소나 가져오기·내보내기: PROPRIX JSON, desktop_pet persona.md(본문만)
import {
  PERSONA_EXPORT_FORMAT,
  type Persona,
  PersonaExport,
  type PersonaExport as PersonaExportType,
  type PersonaInput,
} from "@proprix/shared";

export const DEFAULT_IMPORT_EMOJI = "🙂";
export const DEFAULT_IMPORT_COLOR = "#888888";

export function exportJson(p: Persona): PersonaExportType {
  return {
    format: PERSONA_EXPORT_FORMAT,
    version: 1,
    persona: {
      name: p.name,
      emoji: p.emoji,
      color: p.color,
      description: p.description,
      body: p.body,
      petCharacterId: p.petCharacterId,
      avatarImage: p.avatarImage,
    },
  };
}

// 성공하면 입력값, 실패하면 사유
export function importJson(data: unknown): PersonaInput | string {
  const parsed = PersonaExport.safeParse(data);
  if (!parsed.success) return `PROPRIX 페르소나 파일이 아님: ${parsed.error.issues[0]?.message ?? ""}`;
  return parsed.data.persona;
}

// desktop_pet persona.md: 형식이 자유로우므로 본문 전체를 그대로 쓴다. 이름은 "이름: X" 또는 "name: X" 줄에서
export function importMarkdown(text: string, name?: string): PersonaInput {
  const found = /^[\s\-*]*(?:이름|name)\s*[:：]\s*(.+)$/im.exec(text)?.[1]?.trim();
  return {
    name: (name || found || "가져온 페르소나").slice(0, 40),
    emoji: DEFAULT_IMPORT_EMOJI,
    color: DEFAULT_IMPORT_COLOR,
    description: "",
    body: text.replace(/\r\n/g, "\n").trim(),
    petCharacterId: "",
    avatarImage: "",
  };
}

export function exportMarkdown(p: Persona): string {
  return `${p.body.trim()}\n`;
}

// Content-Disposition 용 파일 이름: 경로·제어 문자를 빼고, 비 ASCII 는 filename* 로
export function contentDisposition(baseName: string, ext: string): string {
  const noControl = [...baseName].map((c) => ((c.codePointAt(0) ?? 0) < 0x20 ? "_" : c)).join("");
  const safe = noControl.replace(/[\\/:*?"<>|]/g, "_").trim() || "persona";
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${safe}.${ext}`)}`;
}
