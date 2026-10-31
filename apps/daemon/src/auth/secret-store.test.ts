import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore } from "./secret-store";

describe.if(process.platform === "win32")("DPAPI 저장", () => {
  test("왕복, 파일에 평문 없음, 변조 거부", () => {
    const dir = mkdtempSync(join(tmpdir(), "proprix-secret-"));
    const path = join(dir, "c.bin");
    try {
      const store = createSecretStore(path);
      expect(store.read()).toBeNull();
      const secret = JSON.stringify({ refresh_token: "rt_very_secret_value", email: "한글@example.test" });
      store.write(secret);
      expect(store.read()).toBe(secret);

      const raw = readFileSync(path);
      expect(raw.includes(Buffer.from("rt_very_secret_value"))).toBe(false);

      const tampered = Buffer.from(raw);
      tampered[tampered.length - 5] = (tampered[tampered.length - 5] ?? 0) ^ 0xff;
      writeFileSync(path, tampered);
      expect(store.read()).toBeNull();

      store.remove();
      expect(store.read()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
