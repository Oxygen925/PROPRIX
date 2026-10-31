// 명령 실행 정책 (P7a — 명령 실행과 skill 스크립트가 함께 쓴다, 사용자 결정 2026-10-29)
// 하는 것: 작업 폴더 안 cwd, stdin 닫음, 비밀 환경 변수 제거, 제한 시간, 출력 상한, 중지 시 프로세스 트리 종료, 늘 확인
// 막지 못하는 것 (화면에도 그대로 적는다): 폴더 밖 파일·네트워크·다른 프로그램·시스템 설정 — 사용자 권한으로 할 수 있는 모든 일.
// 셸은 가둘 수 없으므로 승인이 유일한 방어선이다. 명령으로 바뀐 파일은 추적·복구하지 않는다
export { SHELL_LIMITS } from "@proprix/shared";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 10 * 60_000;
export const OUTPUT_MAX = 20_000; // stdout·stderr 각각 (넘으면 앞뒤만)

const SECRET_ENV =
  /^PROPRIX_|TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|CREDENTIAL|PRIVATE_?KEY|COOKIE|SESSION/i;

/** 자식 프로세스에 넘길 환경 변수: PROPRIX_* 와 토큰·키 류를 뺀다 */
export function scrubEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SECRET_ENV.test(k)) out[k] = v;
  return out;
}

export interface RunSpec {
  cmd: string[]; // 실행 파일 + 인자 (셸 문자열 보간 없음)
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>; // 더할 환경 변수 (실행기 설정 등)
}

export interface RunResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  cancelled: boolean;
}

function clip(s: string): string {
  if (s.length <= OUTPUT_MAX) return s;
  const half = OUTPUT_MAX / 2;
  return `${s.slice(0, half)}\n…(${s.length - OUTPUT_MAX}자 생략)…\n${s.slice(-half)}`;
}

// Windows: 자식까지 함께 끝낸다
function killTree(pid: number) {
  try {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // 이미 끝났으면 무시
  }
}

export async function runProcess(spec: RunSpec): Promise<RunResult> {
  const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  const proc = Bun.spawn(spec.cmd, {
    cwd: spec.cwd,
    env: { ...scrubEnv(), ...spec.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const out = drain(proc.stdout);
  const err = drain(proc.stderr);
  // 시간 초과·중지: 프로세스 트리를 끝내고, 프로세스가 끝나기를 더 기다리지 않는다
  let stop = () => {};
  const stopped = new Promise<void>((res) => {
    stop = res;
  });
  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(proc.pid);
    stop();
  }, timeoutMs);
  const onAbort = () => {
    cancelled = true;
    killTree(proc.pid);
    stop();
  };
  spec.signal?.addEventListener("abort", onAbort, { once: true });
  if (spec.signal?.aborted) onAbort();
  try {
    let code: number | null = null;
    await Promise.race([proc.exited.then((c) => (code = c)), stopped]);
    // 손자 프로세스가 핸들을 쥐고 있으면 파이프가 닫히지 않는다 → 조금만 더 읽고 끝낸다
    await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(2000)]);
    out.cancel();
    err.cancel();
    return {
      exit_code: timedOut || cancelled ? null : code,
      stdout: clip(out.text()),
      stderr: clip(err.text()),
      timed_out: timedOut,
      cancelled,
    };
  } finally {
    clearTimeout(timer);
    spec.signal?.removeEventListener("abort", onAbort);
  }
}

const KEEP_BYTES = 1024 * 1024; // 출력은 이만큼만 모은다 (그 뒤는 버림)

function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let dropped = false;
  const done = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (kept < KEEP_BYTES) {
          chunks.push(value);
          kept += value.length;
        } else dropped = true;
      }
    } catch {
      // 취소됨
    }
  })();
  return {
    done,
    cancel: () => void reader.cancel().catch(() => {}),
    text: () => decode(Buffer.concat(chunks), dropped) + (dropped ? "\n…(출력이 너무 많아 뒷부분은 버림)" : ""),
  };
}

// UTF-8 이 아니면 CP949 로 (Windows 프로그램 출력). 잘린 출력은 끝 글자가 깨질 수 있어 UTF-8 로 너그럽게
function decode(buf: Buffer, cut: boolean): string {
  if (cut) return buf.toString("utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("euc-kr").decode(buf);
  }
}

/** PowerShell 명령 한 줄 실행 (출력은 UTF-8 로) */
export function powershell(command: string): string[] {
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ${command}`,
  ];
}
