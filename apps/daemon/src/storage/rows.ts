// 저장소들이 함께 쓰는 행 처리

// JSON 배열 칸 → 문자열 id 목록 (깨졌거나 배열이 아니면 빈 목록, 문자열이 아닌 항목은 뺀다)
export function parseIds(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const isUnique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/.test(e.message);
