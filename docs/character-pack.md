# 표정 묶음 (zip)

페르소나 편집기의 '표정 zip 올리기'로 넣는다. 올리면 단일 이미지보다 먼저 쓰인다. 단일 이미지는 움직이지 않는다.

## 구조

zip 맨 위(또는 폴더 하나 아래)에 `character.json` 과 이미지를 둔다.

```json
{
  "format": "proprix-character",
  "version": 1,
  "kind": "expressions",
  "thumbnail": "idle.webp",
  "expressions": {
    "idle": "idle.webp",
    "blink": "blink.webp",
    "thinking": "thinking.webp",
    "working": "working.webp",
    "waiting": "waiting.webp",
    "blocked": "blocked.webp",
    "done": "done.webp",
    "talking": ["talk1.webp", "talk2.webp"]
  }
}
```

- `idle` 만 필수다. 없는 표정은 `idle` 을 쓴다.
- 값은 파일 이름 하나 또는 목록(8개까지)이다. 목록이면 번갈아 보인다.
- `blink` 는 4~7초마다 잠깐 보인다. `talking` 은 답을 쓰는 동안 쓴다.
- `thumbnail` 은 선택이며, 캐릭터 움직임을 끈 화면에서 쓴다.
- 아바타는 원형으로 잘린다. 정사각형 이미지가 좋다.

## 제한

| 항목 | 상한 |
|---|---|
| zip | 20MB |
| 파일 수 | 64개 |
| 압축을 푼 전체 | 40MB |
| 이미지 하나 | 2MB |
| 쓰는 이미지 전체 | 20MB |

이미지는 png·jpeg·webp 만 받으며 확장자가 아니라 내용으로 확인한다. `svg` 는 받지 않는다. `character.json` 에 적지 않은 파일은 저장하지 않는다.

## 저장과 백업

`<데이터 폴더>/characters/<페르소나 id>/` 에 저장한다. 일일 백업에는 .sqlite 와 같은 이름의 `-files` 폴더로 복사된다. '표정 zip 내보내기'로 원본을 받아 둘 수도 있다.
