-- 에이전트별 사이트 계정 (P12c, 사용자 결정 2026-10-30): 아이디·비밀번호를 저장해 로그인 폼에 자동 입력한다.
-- 비밀번호와 로그인 쿠키는 DB 에 넣지 않는다 (<dataDir>/auth/site/ 아래 DPAPI 로 암호화한 파일)
CREATE TABLE site_accounts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  login_url TEXT NOT NULL,
  username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown', -- unknown | ok | failed | needs_attention
  last_error TEXT NOT NULL DEFAULT '',
  failures INTEGER NOT NULL DEFAULT 0,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (agent_id, domain)
);
