import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp(config);

const linkBase = config.uiOrigin ?? app.api.url;
console.log(`[proprix] daemon ${config.version} — ${app.api.url}`);
console.log(`[proprix] data: ${config.dataDir}`);
if (config.siwcBase) console.log(`[proprix] 모의 SIWC 서버 사용: ${config.siwcBase}`);
console.log(
  `[proprix] 브라우저에서 열기 (1회용, 5분): ${linkBase}/auth/bootstrap?code=${app.api.guard.issueBootstrapCode()}`,
);
console.log(`[proprix] 이 브라우저로 접속한 적이 있으면 링크 없이 ${linkBase} 로 열면 됩니다 (30일 유지)`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Tauri 셸이 stdin 을 닫거나(종료) 셸이 죽으면 정리하고 끝낸다 — 고아 daemon 이 남지 않게
if (config.exitWithStdin)
  void (async () => {
    for await (const _ of Bun.stdin.stream()) {
      // 셸은 아무것도 보내지 않는다. EOF 만 기다린다
    }
    console.log("[proprix] 셸 연결이 끊김 — 종료");
    await shutdown();
  })();
