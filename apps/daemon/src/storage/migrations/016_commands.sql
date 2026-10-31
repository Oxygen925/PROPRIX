-- 사용자 정의 / 명령 (P7b). name_key = NFC + 영문 소문자로 비교한다.
-- 내장 명령 이름은 예약어, P7c skill 과는 한 이름 공간 (겹침 검사는 코드에서)
CREATE TABLE commands (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  template    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
