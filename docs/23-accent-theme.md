# 화면 테마 (다크 모드·강조색)

모드(라이트/다크/시스템)와 강조색(프리셋 또는 사용자 HEX)을 설정한다. 설정은 **계정에 저장**되고, 로컬에도 캐시해 로그인 전·오프라인에서도 사용한다.

## 1. 동작

- **모드**: `light` / `dark` / `system`(기본)
  - `system` 은 `prefers-color-scheme` 을 따라가며, OS 설정이 바뀌면 즉시 반영한다.
- **강조색**
  - 프리셋: 바이올렛(기본) / 블루 / 에메랄드 / 로즈 / 앰버
  - 사용자 지정: `#RRGGBB`(또는 `#RGB`) 입력·색상 선택
- 위치: 로그인 후 **기기 관리 → 화면 설정**
- **계정 동기화**: 로그인·가입·복구·`GET /api/auth/me` 응답의 테마를 적용한다.
  - 다른 기기에서는 다음 로드/로그인 시 반영된다(실시간 푸시는 하지 않음).
- 로컬 캐시(`localStorage: onemoments:theme`)로 첫 렌더 전에 적용하고, 같은 브라우저의 다른 탭은 `storage` 이벤트로 맞춘다.
- 로그아웃해도 로컬의 마지막 테마는 유지되고, 다음 로그인에서 해당 계정 테마가 적용된다.
- 가입 시에는 현재 브라우저의 테마를 새 계정의 초기값으로 저장한다.
- 강조색이 매우 밝으면 강조 배경 위 글자색(`--accent-contrast`)을 자동으로 어둡게 선택한다.

## 2. 저장

| 위치 | 내용 |
|---|---|
| `users.theme_mode` | `light` / `dark` / `system` (CHECK) |
| `users.theme_accent` | 프리셋 ID 또는 소문자 `#rrggbb` (CHECK) |
| `localStorage: onemoments:theme` | `{ mode, accent }` 로컬 캐시. 이전 `onemoments:accent` 키는 자동 마이그레이션 |

## 3. API

| 메서드 | 경로 | 설명 |
|---|---|---|
| PUT | `/api/auth/theme` | `{ mode, accent }` — 세션 + CSRF, 계정 테마 저장 |
| GET | `/api/auth/me` | `theme: { mode, accent }` 포함 |
| POST | `/api/auth/register` · `login` · `recover` | 응답에 `theme` 포함 |

- `accent` 는 `violet|blue|emerald|rose|amber` 또는 `#rrggbb` 만 허용한다(서버·DB CHECK).
- 테마는 인증 응답에서만 내려가며 사용자 검색·대화 참여자 정보에는 노출하지 않는다.

## 4. 구현

| 위치 | 역할 |
|---|---|
| `client/src/index.css` | `@custom-variant dark`, `--accent-base`/`--accent-contrast`, `accent-50~950` 팔레트, 다크 모드 중립·상태 색 매핑 |
| `client/src/lib/theme.ts` | 정규화·HEX 검증·대비 계산·로컬 저장·`html.dark`/`data-accent` 적용 |
| `client/src/session.tsx` | 서버 테마 적용, `updateTheme` API, 탭 간 동기화 |
| `client/src/components/ThemeSettings.tsx` | 모드·프리셋·HEX 설정 UI |
| `client/src/pages/DevicesPage.tsx` | "화면 설정" 카드 |
| `client/src/main.tsx` | 첫 렌더 전 적용, 시스템 모드 변경·storage 이벤트 |

- 색상 shade 는 `color-mix(in oklab, var(--accent-base) …, white|black)` 로 파생한다.
- **강조색 배경 위 텍스트는 `text-white` 대신 `text-accent-contrast`** 를 사용한다(사용자 HEX 대응).
- 다크 모드는 기존 중립 유틸리티(`bg-white`, `bg-zinc-*`, `text-zinc-*`, `border-zinc-*`)를 `.dark` 스코프에서 어두운 값으로 매핑한다.
  - 새 컴포넌트도 같은 유틸리티를 쓰면 자동으로 다크 모드에 맞는다.
  - 강조 틴트(`bg-accent-50/100`, `text-accent-600/700`, `ring-accent-100`)와 상태 색(red/amber/emerald)은 별도 다크 값으로 보정한다.

## 5. 검증

- 서버 `test/api-theme.test.ts`: 기본값, 모드·HEX 저장, 재로그인 유지, 계정별 분리, 검증·CSRF
- 클라이언트 `client/src/lib/theme.test.ts`: 정규화, HEX 파싱, 대비 선택, 프리셋
- 프로덕션 빌드에서 `text-accent-contrast`, `bg-accent-600`, `.dark .bg-white` 등 생성 확인

## 6. 한계

- 다른 기기와 **실시간** 동기화는 하지 않는다(다음 로드/로그인 시).
- `color-mix` 를 사용하므로 최신 브라우저가 대상이다.
- 다크 모드는 기존 유틸리티 매핑 방식이라, 완전히 새로운 색상 유틸리티를 쓰는 컴포넌트는 별도 다크 값을 추가해야 한다.
- PWA 아이콘·매니페스트 색은 바꾸지 않는다(브라우저 UI 색은 `meta[name=theme-color]` 로 런타임 반영).
- 사용자 HEX는 대비만 보정하며, 색상 미학·색각 이상까지 보장하지는 않는다.
- `localStorage` 를 지우면 로그인 전에는 기본값으로 보이고, 로그인하면 계정 테마가 복원된다.

