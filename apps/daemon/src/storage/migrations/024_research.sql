-- 자율 웹 리서치 (P11): 앱이 단계를 정해 진행한다 — 검색어 → 검색 → 페이지 읽기·요약 → 링크 따라가기 → 글쓰기 → 저장
-- (사용자 결정 2026-10-30). 웹 내용은 도구 없는 요청에만 들어가고, 결과는 앱이 직접 메모·작업 폴더 파일로 저장한다.
-- 페이지 원문은 저장하지 않는다 (요약·짧은 인용·주소·제목만)
CREATE TABLE research (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  goal        TEXT NOT NULL,                 -- 무엇을 조사할지
  instruction TEXT NOT NULL DEFAULT '',      -- 결과 글: 감상문·평가·요약 + 자유 지시
  agent_id    TEXT NOT NULL,                 -- 글을 쓰는 에이전트 (말투·역할)
  scope       TEXT NOT NULL,                 -- JSON {maxPages, depth, queries, domains[]}
  output      TEXT NOT NULL,                 -- JSON {target:'note'|'file', roomId, path}
  schedule    TEXT,                          -- JSON TaskSchedule (P11c), NULL = 바로 실행만
  next_run_at INTEGER,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE research_runs (
  id          TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,                 -- running | done | partial | failed | cancelled | skipped
  stage       TEXT NOT NULL DEFAULT '',      -- queries | search | read | write | save
  pages       INTEGER NOT NULL DEFAULT 0,    -- 읽은 페이지 수
  requests    INTEGER NOT NULL DEFAULT 0,    -- LLM 요청 수
  error       TEXT NOT NULL DEFAULT '',
  result      TEXT NOT NULL DEFAULT '',      -- 결과 글 (마크다운)
  note_id     TEXT NOT NULL DEFAULT '',
  change_id   TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL DEFAULT '',      -- 파일로 저장했으면 작업 폴더 안 경로
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX research_runs_by_research ON research_runs (research_id, started_at);

CREATE TABLE research_pages (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  research_id TEXT NOT NULL,
  url         TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  depth       INTEGER NOT NULL,
  status      TEXT NOT NULL,                 -- ok | blocked | robots | denied | error | timeout
  relevant    INTEGER NOT NULL DEFAULT 0,
  summary     TEXT NOT NULL DEFAULT '',
  quotes      TEXT NOT NULL DEFAULT '[]',    -- JSON 짧은 인용 (25단어 이하, 최대 2개)
  fetched_at  INTEGER NOT NULL
);
CREATE INDEX research_pages_run ON research_pages (run_id, fetched_at);
-- 반복 실행에서 이미 읽은 주소를 건너뛴다 (P11c)
CREATE INDEX research_pages_seen ON research_pages (research_id, url);
