// 리서치 브라우저 연결 (P11a): headless shell 을 직접 띄우고 Bun 기본 WebSocket 으로 Chrome DevTools Protocol 을 쓴다.
// (Playwright 라이브러리는 Bun 에서 --remote-debugging-pipe·ws 연결 모두 멈춰 쓰지 않는다 — spike 2026-10-30)
// 디버깅 포트는 127.0.0.1 의 임의 포트이고, 프로필은 실행마다 새 임시 폴더 (끝나면 지운다)
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { message: string };
};

export class CdpError extends Error {}

export class Cdp {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(m: CdpMessage) => void>();
  closed = false;

  constructor(private readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      let m: CdpMessage;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new CdpError(m.error.message));
        else p.resolve(m.result);
      } else for (const l of this.listeners) l(m);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new CdpError("browser closed"));
      this.pending.clear();
    };
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new CdpError("CDP 연결 시간 초과")), timeoutMs);
      ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new CdpError("CDP 연결 실패"));
      };
    });
    return new Cdp(ws);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 20_000,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError("browser closed"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} 시간 초과`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: (m: CdpMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // 이미 닫힘
    }
  }
}

const ARGS = [
  "--headless",
  "--remote-debugging-port=0",
  "--remote-debugging-address=127.0.0.1",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  "--disable-component-update",
  "--disable-default-apps",
  "--mute-audio",
  "--hide-scrollbars",
];

export class Chromium {
  private constructor(
    private readonly proc: ReturnType<typeof Bun.spawn>,
    private readonly profile: string,
    readonly cdp: Cdp,
  ) {}

  static async launch(exe: string, profileRoot: string, timeoutMs = 15_000): Promise<Chromium> {
    const profile = mkdtempSync(join(profileRoot, "profile-"));
    const proc = Bun.spawn([exe, ...ARGS, `--user-data-dir=${profile}`, "about:blank"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    try {
      const url = await devtoolsUrl(proc.stderr as ReadableStream<Uint8Array>, timeoutMs);
      return new Chromium(proc, profile, await Cdp.connect(url));
    } catch (err) {
      proc.kill();
      rmSync(profile, { recursive: true, force: true });
      throw err;
    }
  }

  get alive(): boolean {
    return !this.cdp.closed && this.proc.exitCode === null;
  }

  async close() {
    this.cdp.close();
    this.proc.kill();
    await this.proc.exited.catch(() => {});
    // 프로세스가 파일을 놓을 때까지 잠깐 걸릴 수 있다
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(this.profile, { recursive: true, force: true });
        return;
      } catch {
        await Bun.sleep(200);
      }
    }
  }
}

// stderr 의 "DevTools listening on ws://..." 를 기다린다. 그 뒤에도 계속 비운다 (가득 차면 브라우저가 멈춘다)
async function devtoolsUrl(stderr: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const url = /DevTools listening on (ws:\/\/\S+)/.exec(buf)?.[1];
      if (url) {
        void drain(reader);
        return url;
      }
      if (buf.length > 64_000) buf = buf.slice(-4000);
    }
  } finally {
    clearTimeout(timer);
  }
  throw new CdpError("브라우저를 시작하지 못했습니다");
}

async function drain(reader: { read(): Promise<{ done: boolean }> }) {
  try {
    while (!(await reader.read()).done) {
      // 버린다
    }
  } catch {
    // 브라우저가 닫힘
  }
}
