// 리서치 브라우저 설치 (P11a): 내려받기 → SHA-256 확인 → 풀기, 실패하면 다음 주소, 다 틀리면 오류, 지우기
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserStatus } from "@proprix/shared";
import { zipSync } from "fflate";
import { BrowserInstaller, CHROMIUM } from "./install";

const root = mkdtempSync(join(tmpdir(), "proprix-install-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const zip = zipSync({ "chrome-headless-shell-win64/chrome-headless-shell.exe": new TextEncoder().encode("exe") });
const sha = new Bun.CryptoHasher("sha256").update(zip).digest("hex");
const build = {
  ...CHROMIUM,
  version: "1.0.0",
  sha256: sha,
  size: zip.byteLength,
  urls: ["https://a.test/x.zip", "https://b.test/x.zip"],
};

test.skipIf(process.platform !== "win32")(
  "첫 주소가 실패하면 다음 주소, 확인 뒤 풀고 상태를 알린다, 지우기",
  async () => {
    const dir = join(root, "ok");
    const seen: string[] = [];
    const statuses: BrowserStatus[] = [];
    const inst = new BrowserInstaller(
      dir,
      (s) => statuses.push(s),
      (async (url: string) => {
        seen.push(url);
        return url.startsWith("https://a.test") ? new Response("x", { status: 500 }) : new Response(zip);
      }) as unknown as typeof fetch,
      build,
    );
    expect(inst.status()).toMatchObject({ installed: false, version: "1.0.0", downloadSize: zip.byteLength });
    await inst.install();
    expect(seen).toEqual(build.urls);
    expect(inst.exePath()).not.toBeNull();
    expect(inst.status()).toMatchObject({ installed: true, error: "", installing: null });
    expect(statuses.at(-1)?.installed).toBe(true);
    expect(existsSync(join(dir, "1.0.0.zip"))).toBe(false); // zip 은 지운다
    inst.remove();
    expect(inst.status().installed).toBe(false);
  },
);

test.skipIf(process.platform !== "win32")("SHA-256 이 다르면 설치하지 않고 오류", async () => {
  const dir = join(root, "bad");
  const inst = new BrowserInstaller(dir, () => {}, (async () => new Response(zip)) as unknown as typeof fetch, {
    ...build,
    sha256: "0".repeat(64),
  });
  await inst.install();
  expect(inst.exePath()).toBeNull();
  expect(inst.status().error).toContain("SHA-256");
});
