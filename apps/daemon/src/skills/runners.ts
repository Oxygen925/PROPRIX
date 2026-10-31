// 스크립트 실행기 점검: PATH 에서 절대 경로를 찾고 버전을 확인한다. 없거나 동작하지 않으면 그 확장자 스크립트는 실행 불가
// (Windows 의 python.exe 앱 실행 별칭은 스토어만 여는 껍데기라 --version 이 실패한다 → 다음 후보로)
import { tmpdir } from "node:os";
import type { RunnerId, RunnerStatus } from "@proprix/shared";
import { runProcess } from "../tools/exec-policy";

interface RunnerDef {
  id: RunnerId;
  label: string;
  exts: string[];
  candidates: { bin: string; prefix: string[] }[]; // prefix: 실행 파일 뒤, 스크립트 앞에 붙는 인자
  versionArgs: string[];
  versionOk: RegExp;
  env?: Record<string, string>;
}

const RUNNERS: RunnerDef[] = [
  {
    id: "python",
    label: "Python",
    exts: ["py"],
    candidates: [
      { bin: "python", prefix: [] },
      { bin: "python3", prefix: [] },
      { bin: "py", prefix: ["-3"] },
    ],
    versionArgs: ["--version"],
    versionOk: /Python (3\.\d+(?:\.\d+)?)/,
    env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }, // 출력이 CP949 로 나오지 않게
  },
  {
    id: "bun",
    label: "Bun",
    exts: ["js", "mjs", "cjs", "ts"],
    candidates: [{ bin: "bun", prefix: [] }],
    versionArgs: ["--version"],
    versionOk: /^\d+(?:\.\d+)+/,
  },
  {
    id: "powershell",
    label: "PowerShell",
    exts: ["ps1"],
    // PowerShell 7 이 있으면 먼저 (BOM 없는 UTF-8 을 바로 읽는다). 서명되지 않은 스크립트도 이 프로세스에서만 실행
    // (매번 사용자 확인을 거친다)
    candidates: [
      { bin: "pwsh", prefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"] },
      { bin: "powershell", prefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"] },
    ],
    versionArgs: ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    versionOk: /^\d+(?:\.\d+)+/,
  },
];

interface Found {
  status: RunnerStatus;
  prefix: string[];
  env?: Record<string, string>;
}

export class Runners {
  private found = new Map<RunnerId, Found>();
  private pending: Promise<RunnerStatus[]> | null = null;

  constructor(private readonly which: (bin: string) => string | null = (b) => Bun.which(b)) {}

  /** 점검 결과 (force 면 다시 점검) */
  check(force = false): Promise<RunnerStatus[]> {
    if (!force && this.found.size === RUNNERS.length) return Promise.resolve(this.list());
    this.pending ??= this.probeAll().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  list(): RunnerStatus[] {
    return RUNNERS.map((r) => this.found.get(r.id)?.status ?? missing(r, "아직 점검하지 않음"));
  }

  status(id: RunnerId): RunnerStatus | undefined {
    return this.found.get(id)?.status;
  }

  /** 스크립트 실행 명령 (실행기 절대 경로 + 앞 인자 + 스크립트 + 인자 배열). 실행할 수 없으면 null */
  command(id: RunnerId, script: string, args: string[]): { cmd: string[]; env?: Record<string, string> } | null {
    const f = this.found.get(id);
    if (!f?.status.ok) return null;
    return { cmd: [f.status.path, ...f.prefix, script, ...args], env: f.env };
  }

  private async probeAll(): Promise<RunnerStatus[]> {
    await Promise.all(RUNNERS.map(async (r) => this.found.set(r.id, await this.probe(r))));
    return this.list();
  }

  private async probe(r: RunnerDef): Promise<Found> {
    let last = "PATH 에서 찾지 못함";
    for (const c of r.candidates) {
      const path = this.which(c.bin);
      if (!path) continue;
      try {
        const res = await runProcess({ cmd: [path, ...r.versionArgs], cwd: tmpdir(), timeoutMs: 8000 });
        const out = `${res.stdout}\n${res.stderr}`.trim();
        const m = r.versionOk.exec(out);
        const version = m?.[1] ?? m?.[0] ?? "";
        if (res.exit_code === 0 && version)
          return { status: { ...base(r), path, version, ok: true, error: "" }, prefix: c.prefix, env: r.env };
        last = `${c.bin} 가 동작하지 않음 (${res.timed_out ? "시간 초과" : out.split("\n")[0] || `종료 코드 ${res.exit_code}`})`;
      } catch {
        last = `${c.bin} 를 실행할 수 없음`;
      }
    }
    return { status: missing(r, last), prefix: [] };
  }
}

const base = (r: RunnerDef) => ({ id: r.id, label: r.label, exts: r.exts });
const missing = (r: RunnerDef, error: string): RunnerStatus => ({
  ...base(r),
  path: "",
  version: "",
  ok: false,
  error,
});
