// 자격 증명 파일 저장: Windows 는 DPAPI(CurrentUser + 앱 entropy), 그 밖은 0600 평문 파일 (SIWC 문서 권장).
// 쓰기는 임시 파일 → rename 으로 원자적으로 교체한다 (교체된 refresh 토큰이 반쯤 쓰인 채 남지 않게).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SecretStore {
  read(): string | null;
  write(plain: string): void;
  remove(): void;
}

export class MemorySecretStore implements SecretStore {
  value: string | null = null;
  read() {
    return this.value;
  }
  write(plain: string) {
    this.value = plain;
  }
  remove() {
    this.value = null;
  }
}

function writeAtomic(path: string, data: Uint8Array) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export class FileSecretStore implements SecretStore {
  constructor(
    private readonly path: string,
    private readonly codec: { seal(b: Uint8Array): Uint8Array; open(b: Uint8Array): Uint8Array | null } = PLAIN,
  ) {}

  read(): string | null {
    if (!existsSync(this.path)) return null;
    const opened = this.codec.open(new Uint8Array(readFileSync(this.path)));
    if (!opened) {
      console.warn("[auth] 자격 증명 파일을 열 수 없음 — 로그아웃 상태로 시작");
      return null;
    }
    const text = new TextDecoder().decode(opened);
    opened.fill(0);
    return text;
  }

  write(plain: string) {
    const bytes = new TextEncoder().encode(plain);
    writeAtomic(this.path, this.codec.seal(bytes));
    bytes.fill(0);
    if (process.platform !== "win32") chmodSync(this.path, 0o600);
  }

  remove() {
    rmSync(this.path, { force: true });
  }
}

const PLAIN = { seal: (b: Uint8Array) => b.slice(), open: (b: Uint8Array) => b.slice() };

export function createSecretStore(path: string): SecretStore {
  if (process.platform === "win32") {
    const { dpapi } = require("./dpapi") as typeof import("./dpapi");
    return new FileSecretStore(path, dpapi);
  }
  return new FileSecretStore(path);
}
