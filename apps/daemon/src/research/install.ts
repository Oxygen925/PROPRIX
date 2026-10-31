// 리서치 브라우저 설치 (P11a): Playwright 1.64.1 이 쓰는 Chrome for Testing headless shell 을 처음 쓸 때 내려받는다
// (사용자 결정 2026-10-30). 받은 zip 은 SHA-256 을 확인한 뒤 <dataDir>/browser/<버전> 에 푼다.
// Playwright 라이브러리 자체는 Bun 에서 연결되지 않아(파이프·ws 모두) 같은 Chromium 을 CDP 로 직접 다룬다 (cdp.ts)
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BrowserStatus } from "@proprix/shared";
import { unzipSync } from "fflate";

export const CHROMIUM = {
  version: "156.0.8078.4",
  sha256: "5af4c82cf4b351ec4bad4c71dcf938af14fccea8a0eb0d5c2a7b49ccc922698c",
  size: 123_826_519,
  urls: [
    "https://cdn.playwright.dev/builds/cft/156.0.8078.4/win64/chrome-headless-shell-win64.zip",
    "https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.4/win64/chrome-headless-shell-win64.zip",
  ],
  exe: join("chrome-headless-shell-win64", "chrome-headless-shell.exe"),
};

function dirSize(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

export class BrowserInstaller {
  private installing: { received: number; total: number; stage: "download" | "extract" } | null = null;
  private error = "";
  private abort: AbortController | null = null;
  private sizeCache: number | null = null;

  constructor(
    private readonly dir: string, // <dataDir>/browser
    private readonly onStatus: (s: BrowserStatus) => void = () => {},
    private readonly fetcher: typeof fetch = fetch,
    private readonly build = CHROMIUM,
  ) {}

  private get versionDir() {
    return join(this.dir, this.build.version);
  }

  /** 설치돼 있으면 실행 파일 경로 */
  exePath(): string | null {
    const p = join(this.versionDir, this.build.exe);
    return existsSync(p) ? p : null;
  }

  status(): BrowserStatus {
    const installed = this.exePath() !== null;
    if (installed && this.sizeCache === null) this.sizeCache = dirSize(this.versionDir);
    return {
      version: this.build.version,
      installed,
      size: installed ? (this.sizeCache ?? 0) : 0,
      downloadSize: this.build.size,
      installing: this.installing,
      error: this.error,
    };
  }

  private publish() {
    this.onStatus(this.status());
  }

  /** 내려받고 확인한 뒤 푼다. 이미 받는 중이면 그대로 */
  async install(): Promise<void> {
    if (this.installing || this.exePath()) return;
    if (process.platform !== "win32") {
      this.error = "리서치 브라우저는 지금 Windows 만 지원합니다";
      return this.publish();
    }
    this.error = "";
    this.installing = { received: 0, total: this.build.size, stage: "download" };
    this.abort = new AbortController();
    this.publish();
    mkdirSync(this.dir, { recursive: true });
    const zip = join(this.dir, `${this.build.version}.zip`);
    const tmp = join(this.dir, `${this.build.version}.tmp`);
    try {
      await this.download(zip, this.abort.signal);
      this.installing = { received: this.build.size, total: this.build.size, stage: "extract" };
      this.publish();
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      await extract(zip, tmp);
      if (!existsSync(join(tmp, this.build.exe))) throw new Error("압축을 풀었지만 실행 파일이 없습니다");
      rmSync(this.versionDir, { recursive: true, force: true });
      renameSync(tmp, this.versionDir);
      // 예전 버전은 지운다
      for (const e of readdirSync(this.dir))
        if (e !== this.build.version) rmSync(join(this.dir, e), { recursive: true, force: true });
      this.sizeCache = null;
    } catch (err) {
      this.error = this.abort?.signal.aborted ? "취소했습니다" : err instanceof Error ? err.message : String(err);
      rmSync(tmp, { recursive: true, force: true });
    } finally {
      rmSync(zip, { force: true });
      this.installing = null;
      this.abort = null;
      this.publish();
    }
  }

  cancel() {
    this.abort?.abort();
  }

  /** 설치한 브라우저를 지운다 (돌고 있으면 먼저 닫아야 한다) */
  remove() {
    rmSync(this.dir, { recursive: true, force: true });
    this.sizeCache = null;
    this.error = "";
    this.publish();
  }

  private async download(file: string, signal: AbortSignal) {
    let lastError = "";
    for (const url of this.build.urls) {
      try {
        const res = await this.fetcher(url, { signal, redirect: "follow" });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const hasher = new Bun.CryptoHasher("sha256");
        const writer = Bun.file(file).writer();
        let received = 0;
        let last = 0;
        for await (const chunk of res.body) {
          hasher.update(chunk);
          writer.write(chunk);
          received += chunk.byteLength;
          if (received > this.build.size * 1.1) throw new Error("예상보다 큰 파일");
          if (Date.now() - last > 300) {
            last = Date.now();
            this.installing = { received, total: this.build.size, stage: "download" };
            this.publish();
          }
        }
        await writer.end();
        const sum = hasher.digest("hex");
        if (sum !== this.build.sha256) throw new Error("내려받은 파일의 SHA-256 이 맞지 않습니다");
        return;
      } catch (err) {
        if (signal.aborted) throw err;
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(`내려받지 못했습니다: ${lastError}`);
  }
}

// Windows 기본 tar(bsdtar)로 푼다. 없으면 fflate (메모리를 많이 쓴다)
async function extract(zip: string, dest: string) {
  try {
    const p = Bun.spawn(["tar", "-xf", zip, "-C", dest], { stdout: "ignore", stderr: "pipe" });
    if ((await p.exited) === 0) return;
  } catch {
    // tar 가 없다
  }
  const files = unzipSync(new Uint8Array(await Bun.file(zip).arrayBuffer()));
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    const out = join(dest, name);
    if (!out.startsWith(dest)) continue; // zip 경로 탈출 방지
    mkdirSync(join(out, ".."), { recursive: true });
    await Bun.write(out, data);
  }
}
