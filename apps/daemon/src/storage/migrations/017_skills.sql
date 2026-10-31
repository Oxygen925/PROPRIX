-- Skill (P7c): SKILL.md 폴더를 <dataDir>/skills/<name>/ 에 둔다. 이름은 / 명령과 한 이름 공간 (겹침 검사는 코드에서)
-- hash = 폴더 전체 내용 해시 (가져올 때 기록, 바뀌면 화면에 알린다). source = 가져온 곳 (folder·zip·manual)
CREATE TABLE skills (
  name         TEXT PRIMARY KEY,
  name_key     TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL,
  hash         TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT '',
  installed_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- 에이전트가 쓰는 skill 이름 목록 (JSON 배열). 새 skill 은 아무도 쓰지 않는다 (사용자 결정 2026-10-29)
ALTER TABLE agents ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
