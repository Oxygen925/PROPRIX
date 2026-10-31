# 테마 묶음 (zip)

`설정 > 화면`의 `테마 zip 올리기`로 넣는다. 앱에는 기본 테마만 들어 있고 다른 테마는 따로 배포한다.

## 구조

zip 맨 위(또는 폴더 하나 아래)에 `theme.json` 을 둔다.

```json
{
  "format": "proprix-theme",
  "version": 1,
  "id": "sample",
  "name": "견본 테마",
  "notice": "앱 아래에 항상 보일 안내 문구 (선택)",
  "css": "theme.css",
  "fontCss": "fonts.css",
  "stage": "court",
  "labels": { "debate": "회의", "round": "제{n}막" }
}
```

- `id`: 영문 소문자·숫자·`-`. `studio` 는 쓸 수 없다. 같은 id 를 다시 올리면 바뀐다.
- `notice`: 테마를 켠 동안 앱 맨 아래에 항상 보인다 (200자까지).
- `css`: 필수. `fontCss`: 선택. 글꼴은 `fontCss` 에 두면 첫 화면을 그릴 때 기다리지 않는다.
- `stage`: 토론 화면. `board`(기본, 초점 + 타임라인) 또는 `court`(법정 무대). 테마를 켠 동안 쓴다.

- `labels`: 화면 이름 바꾸기 (값은 30자까지). 쓸 수 있는 키:

| 키 | 기본 이름 |
|---|---|
| `debate` | 토론 |
| `closing` | 맺는 말, 판결 |
| `moderator` | 진행자, 재판장 |
| `participant` | 참여자 |
| `tools` | 작업대의 도구 |
| `evidence` | 법정 무대의 증거 |
| `round` | 법정 무대의 라운드 (`{n}` 은 번호) |
| `court.open` | 법정 무대의 시작 선언 |
| `workroom` | 작업실 |
| `zone.search`·`zone.tools`·`zone.write`·`zone.debate`·`zone.research`·`zone.rest` | 작업실 칸 |

## CSS

테마를 켜면 `<html data-theme="id">` 가 되므로 이 선택자 안에 쓴다.

```css
:root[data-theme="sample"] {
  --c-bg: #120c10;
  --c-text: #f1e8dc;
  --font: "Sample", serif;
}
```

색·글꼴·반경은 `apps/web/src/lib/styles/tokens.css` 의 변수를 바꾸면 된다. 화면 구조의 class 는 빌드마다 바뀔 수 있으니 변수와 `data-` 속성을 쓴다.

| 변수 | 바뀌는 것 |
|---|---|
| `--mascot-default-bg`, `--mascot-default-core`, `--mascot-default-orbit` | 기본 페르소나 마스코트의 배경·원·궤도 |
| `--mascot-ink` | 마스코트의 눈 |
| `--stage-bg`, `--stage-line`, `--stage-accent`, `--stage-gold`, `--stage-text`, `--stage-muted`, `--stage-rest-bg`, `--stage-rest-accent` | 법정 무대 |

| 속성 | 위치 |
|---|---|
| `data-ui="rail"` | 왼쪽 아이콘 줄 |
| `data-ui="list"` | 채팅·리서치 목록 |
| `data-ui="main"` | 가운데 영역 |
| `data-ui="panel"` | 오른쪽 패널 |
| `data-ui="composer"` | 입력창 |
| `data-ui="message"`, `data-role="user"`·`"assistant"` | 말풍선 |
| `data-ui="board"`, `data-ui="court"` | 토론 화면 |
| `data-part="cutin"`·`banner`·`evidence`·`gloom`·`stamp` | 법정 무대 연출 |
| `data-part="timeline"` | 법정 무대의 발언 타임라인 |
| `data-ui="workroom"`, `data-zone="search"`·`tools`·`write`·`debate`·`research`·`rest` | 작업실과 칸 |

화면 전환은 `::view-transition-old(root)`, `::view-transition-new(root)` 로 바꾼다.

**쓸 수 없는 것**: 외부 주소, `data:`, `@import`, `@namespace`, `image-set()`, `src()`, `expression()`, 역슬래시 이스케이프. `url()` 은 zip 안의 파일만 가리킬 수 있다. 어기면 올릴 때 거부한다.

## 파일과 제한

`url()` 로 쓰는 파일은 png·jpeg·webp·svg·woff2·woff·ttf·otf 이며 내용으로 확인한다. 스크립트나 외부 참조가 든 svg 는 받지 않는다.

| 항목 | 상한 |
|---|---|
| zip | 30MB |
| 파일 수 | 800개 |
| 압축을 푼 전체 | 60MB |
| 파일 하나 | 5MB |

테마는 화면 모양을 모두 바꿀 수 있어 버튼이나 안내를 다르게 보이게 할 수 있다. 믿을 수 있는 파일만 올린다.

## 저장과 백업

`<데이터 폴더>/themes/<id>/` 에 저장한다. 일일 백업에는 .sqlite 와 같은 이름의 `-files` 폴더로 복사된다. 어떤 테마를 켤지는 기기별로 저장한다.
