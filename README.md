# PROPRIX

ChatGPT 계정으로 로그인(Sign in with ChatGPT)해 본인 플랜으로 동작하는 개인용 멀티 에이전트 앱.
페르소나, 장기 메모리, 도구 호출·선제 메시지, 에이전트 간 상호작용(그룹챗·위임·자율 대화·토론)을 목표로 한다.

> 상태: 0.2.1 시험 배포. Windows x64 전용이며 OpenAI 와 관계없는 개인 프로젝트다. [개인정보 안내](PRIVACY.md), 메모리 검색 평가는 [docs/memory-eval.md](docs/memory-eval.md). 설치본의 제3자 라이선스는 `THIRD_PARTY_NOTICES.txt` 로 함께 배포한다. ChatGPT 로고(`apps/web/src/lib/assets/chatgpt-logo-white.svg`)는 OpenAI 의 상표로 MIT 라이선스 대상이 아니다. 설정에서 고를 수 있는 EmbeddingGemma 는 이 저장소에 들어 있지 않다. Gemma is provided under and subject to the Gemma Terms of Use found at [ai.google.dev/gemma/terms](https://ai.google.dev/gemma/terms).

## 기능

- **대화:** 1인 채팅, 그룹챗(@멘션·라우터·연쇄 상한), 서브 채팅, 자동 제목, 메시지 HTML 서식
- **에이전트:** 페르소나, 장기 기억, 도구 호출, 에이전트 간 위임, Skill, MCP
- **여럿이 함께:** 토론·협업 보드, 라운지(자율 대화, 기본 꺼짐), 리서치, 에이전트가 하는 일을 보여 주는 작업실
- **선제 메시지:** 리마인더, 정기 체크인, 무응답 안부, 방해 금지 시간
- **꾸미기:** 움직이는 마스코트, [표정 zip](docs/character-pack.md), [테마 zip](docs/theme-pack.md)
- **앱:** 트레이 상주, 네이티브 알림, 자동 실행, 일일 백업·복구, 기능별 일일 예산

## 설치

1. 릴리스에서 `PROPRIX_<버전>_x64-setup.exe` 를 받아 실행한다. 함께 올린 SHA-256 으로 파일을 확인할 수 있다.
2. 서명하지 않은 설치 파일이라 SmartScreen 경고가 뜬다. 출처를 확인했으면 '추가 정보' → '실행'을 누른다.
3. WebView2 가 없으면 설치 중에 함께 받는다. 자동 업데이트는 없으므로 새 버전은 직접 받아 덮어 설치한다.
4. 앱에서 ChatGPT 계정으로 로그인한다. 콜백 포트 1455 를 쓰는 다른 프로그램이 있으면 먼저 끈다.

데이터는 `%APPDATA%\PROPRIX` 에 저장되며 앱을 지워도 남는다. 완전히 지우려면 이 폴더를 직접 삭제한다.

**플랜 사용량:** 모든 모델 호출은 로그인한 사용자의 ChatGPT 플랜을 쓴다. 채팅 외에 요약·기억 추출·자동 제목·라우터도 호출하며, 라운지·선제 메시지·토론은 켜 두면 사용자가 말하지 않아도 사용량을 쓸 수 있다. 일일 예산은 설정에서 정한다.

## 구조

| 경로 | 내용 |
|---|---|
| `apps/daemon` | Bun 상주 프로세스. `127.0.0.1` HTTP+WS API, SQLite, SIWC 계정(DPAPI 저장), LlmGate, 페르소나·에이전트, 채팅·롤링 요약, 도구 호출·메모, 장기 메모리 |
| `apps/web` | SvelteKit SPA (adapter-static) |
| `apps/desktop` | Tauri v2 셸. daemon 을 단일 실행 파일(sidecar)로 띄우고 트레이·네이티브 알림·자동 실행을 맡는다 |
| `packages/shared` | API 계약 (zod 스키마) |
| `packages/siwc` | SIWC 프로토콜·Responses SSE (순수 TS, desktop_pet 구현의 이식) |
| `tools/mock-siwc` | 모의 SIWC 서버 (discovery·OAuth·JWKS·models·responses). 테스트와 개발용 |

## 개발

```bash
bun install
bun run dev        # daemon(47800) + vite(5173), 실제 OpenAI. 터미널의 1회용 링크로 접속
bun run dev:mock   # 모의 SIWC(47900) + daemon + vite — 쿼터를 쓰지 않음
bun test
bun run check      # biome + tsc + svelte-check
bun run start      # SPA 빌드 후 daemon 이 직접 서빙
bun run app        # Windows 앱(개발): SPA·daemon 실행 파일 빌드 후 tauri dev
bun run app:build  # Windows 앱 설치 파일 (apps/desktop/src-tauri/target/release/bundle/nsis)
```

앱은 Rust 툴체인(MSVC)과 WebView2 가 필요하다. 데이터는 `%APPDATA%\PROPRIX` 를 쓰며, 개발 빌드는 그 폴더가 비어 있으면
저장소의 `.data` 를 한 번 가져온다(로그인 제외).
앱과 `bun run dev` 를 같은 데이터로 동시에 쓰면 리마인더·체크인이 두 번 갈 수 있으니 하나만 켠다.

환경 변수: `PROPRIX_PORT`, `PROPRIX_DATA_DIR`(기본 `%APPDATA%\PROPRIX`), `PROPRIX_WEB_DIR`, `PROPRIX_API_TOKEN`, `PROPRIX_UI_ORIGIN`, `PROPRIX_ALLOWED_ORIGINS`, `PROPRIX_SIWC_BASE`(모의 서버, `http://127.0.0.1:<port>` 만), `PROPRIX_CALLBACK_PORT`(기본 1455).

## ChatGPT 로그인

- 최초 로그인은 콜백 포트 **1455** 를 쓴다. Codex CLI 등이 이 포트를 쓰고 있으면 종료한 뒤 로그인한다 (다시 로그인은 빈 포트로 대체 가능).
- 자격 증명은 `%APPDATA%\PROPRIX\auth\siwc-<issuer 해시>.bin` 에 DPAPI(현재 사용자)로 암호화해 저장한다. 모의 서버와 실제 계정은 파일이 분리된다.
- 사용량 한도(429)에 걸리면 새 요청을 모두 멈추고 **Manage usage** 를 안내한다. 사용자가 "다시 시도"를 눌러야 재개한다.

## API 보안

- `127.0.0.1` 에만 바인딩, `Host` 검사(DNS rebinding), `Origin` 허용 목록(CSRF·WS 하이재킹).
- 인증: `Authorization: Bearer <PROPRIX_API_TOKEN>` 또는 1회용 부트스트랩 링크로 받은 `HttpOnly; SameSite=Strict` 세션 쿠키.
- 앱: 셸이 실행마다 빈 포트와 토큰을 만들어 daemon 에 넘기고, 창(`http://tauri.localhost`)은 CORS 로 API 를, `?token=` 으로 WebSocket 을 쓴다. 셸이 끝나면(stdin 종료) daemon 도 정리하고 끝난다.

## 라이선스

MIT
