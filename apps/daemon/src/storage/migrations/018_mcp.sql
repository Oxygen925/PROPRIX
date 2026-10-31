-- MCP (P7d): Tools 만. 서버는 필요할 때 연결하고 10분 쓰지 않으면 끊는다 (사용자 결정 2026-10-29)
-- name: 도구 이름 앞부분 (mcp__<name>__<tool>) — 만든 뒤 바꾸지 않는다 ('항상 허용' 규칙·기록이 이 이름을 쓴다)
-- env_enc · headers_enc: DPAPI 로 봉한 JSON (base64). 화면·API 에는 키만 돌려준다
-- trust: ask = 모든 호출 확인 (도구별 '항상 허용'만 적용) · readonly-auto = readOnlyHint 도구만 바로 실행
CREATE TABLE mcp_servers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  transport        TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
  command          TEXT NOT NULL DEFAULT '',
  args             TEXT NOT NULL DEFAULT '[]',
  env_enc          TEXT NOT NULL DEFAULT '',
  url              TEXT NOT NULL DEFAULT '',
  headers_enc      TEXT NOT NULL DEFAULT '',
  trust            TEXT NOT NULL DEFAULT 'ask' CHECK (trust IN ('ask', 'readonly-auto')),
  enabled          INTEGER NOT NULL DEFAULT 1,
  protocol_version TEXT NOT NULL DEFAULT '', -- 마지막 연결에서 협상한 판
  server_info      TEXT NOT NULL DEFAULT '', -- 서버가 알린 이름·버전 (JSON)
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- 서버의 도구. 새로 보인 도구는 꺼져 있다. 켤 때 그 정의를 pinned 로 고정하고, 이후 tools/list 의 정의(definition)가
-- 고정한 것과 다르면 끄고 changed 로 표시한다 (tool poisoning·rug pull). 모델에는 pinned 만 보낸다
CREATE TABLE mcp_tools (
  server_id  TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  exposed    TEXT NOT NULL,            -- 모델에 보이는 이름 mcp__<server>__<tool> (처음 볼 때 정해 고정)
  enabled    INTEGER NOT NULL DEFAULT 0,
  definition TEXT NOT NULL,            -- 마지막 tools/list 의 정의 (JSON)
  pinned     TEXT NOT NULL DEFAULT '', -- 사용자가 켤 때 본 정의 (JSON)
  def_hash   TEXT NOT NULL DEFAULT '', -- pinned 의 해시
  changed    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, name)
);
CREATE UNIQUE INDEX mcp_tools_exposed ON mcp_tools (exposed);

-- 에이전트가 쓰는 MCP 서버 id 목록 (JSON 배열). 새 서버는 아무도 쓰지 않는다 (사용자 결정 2026-10-29)
ALTER TABLE agents ADD COLUMN mcp_servers TEXT NOT NULL DEFAULT '[]';
