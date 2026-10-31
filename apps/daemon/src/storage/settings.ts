import type { Database } from "bun:sqlite";
import { SETTINGS_DEFAULTS, Settings, type SettingsPatch } from "@proprix/shared";
import type { z } from "zod";

export class SettingsStore {
  constructor(private readonly db: Database) {}

  // 키마다 따로 검증: 손상되었거나 예전 형식인 값은 그 키만 기본값으로 (budgets·lounge 는 빠진 항목을 기본값으로 채움)
  all(): Settings {
    const rows = this.db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all();
    const out: Settings = structuredClone(SETTINGS_DEFAULTS);
    for (const r of rows) {
      if (!(r.key in Settings.shape)) continue;
      const key = r.key as keyof Settings;
      let value: unknown;
      try {
        value = JSON.parse(r.value);
      } catch {
        continue;
      }
      const base = SETTINGS_DEFAULTS[key];
      const merged =
        typeof base === "object" && base !== null && typeof value === "object" ? { ...base, ...value } : value;
      const p = Settings.shape[key].safeParse(merged);
      if (p.success) Object.assign(out, { [key]: p.data });
    }
    return out;
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]) {
    this.db
      .query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($key, $value, $t)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run({ key, value: JSON.stringify(value), t: Date.now() });
  }

  // 부분 변경을 현재 값에 합쳐 검증한 뒤 저장. 검증 실패면 첫 오류 메시지
  patch(p: z.infer<typeof SettingsPatch>): Settings | string {
    const cur = this.all();
    const next = Settings.safeParse({
      backup: { ...cur.backup, ...p.backup },
      model: p.model ?? cur.model,
      instructions: p.instructions ?? cur.instructions,
      budgets: { ...cur.budgets, ...p.budgets },
      lounge: { ...cur.lounge, ...p.lounge },
      memory: { ...cur.memory, ...p.memory },
      proactive: { ...cur.proactive, ...p.proactive },
      research: { ...cur.research, ...p.research },
      updateCheck: p.updateCheck ?? cur.updateCheck,
    });
    if (!next.success) return next.error.issues[0]?.message ?? "invalid";
    if (next.data.lounge.startHour >= next.data.lounge.endHour) return "시작 시각이 끝 시각보다 앞서야 한다";
    if (next.data.proactive.quietStart === next.data.proactive.quietEnd) return "방해 금지 시작과 끝이 같을 수 없다";
    if (p.backup) this.set("backup", next.data.backup);
    if (p.model !== undefined) this.set("model", next.data.model);
    if (p.instructions !== undefined) this.set("instructions", next.data.instructions);
    if (p.budgets) this.set("budgets", next.data.budgets);
    if (p.lounge) this.set("lounge", next.data.lounge);
    if (p.memory) this.set("memory", next.data.memory);
    if (p.proactive) this.set("proactive", next.data.proactive);
    if (p.research) this.set("research", next.data.research);
    if (p.updateCheck !== undefined) this.set("updateCheck", next.data.updateCheck);
    return next.data;
  }
}
