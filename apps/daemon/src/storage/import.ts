// 앱(Tauri) 첫 실행: 데이터 폴더가 비어 있으면 개발용 데이터(.data)의 DB 를 한 번 가져온다.
// 로그인(auth/)은 가져오지 않는다 — dev 와 앱이 같은 refresh token 을 쓰면 회전 때문에 한쪽이 재로그인해야 한다
// (사용자 결정 2026-10-29). 임베딩 모델(models/)도 크고 앱에서는 아직 쓰지 못해 가져오지 않는다.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function importDevData(fromDir: string, toDir: string): "imported" | "skipped" {
  const src = join(fromDir, "proprix.sqlite");
  const dst = join(toDir, "proprix.sqlite");
  if (existsSync(dst) || !existsSync(src)) return "skipped";
  // dev daemon 이 열어 둔 채여도 일관된 사본이 되게 (WAL 포함) VACUUM INTO 로 복사한다
  const db = new Database(src, { readonly: true });
  try {
    db.query("VACUUM INTO $dst").run({ $dst: dst });
  } finally {
    db.close();
  }
  console.log(`[proprix] 개발 데이터 가져옴: ${src} → ${dst} (로그인은 앱에서 다시)`);
  return "imported";
}
