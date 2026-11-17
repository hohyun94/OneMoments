# 강조색 테마

앱의 강조색(버튼·포커스·배지·선택 영역)을 바꾸는 로컬 테마 기능이다.

## 1. 동작

- 프리셋: **바이올렛(기본) / 블루 / 에메랄드 / 로즈 / 앰버**
- 위치: 로그인 후 **기기 관리 → 화면 설정**
- 선택값은 `localStorage`(`onemoments:accent`)에만 저장하며 **서버·DB·로그로 전송하지 않는다.**
- 브라우저(프로필)별 설정이며 기기 간 동기화는 하지 않는다.
- 같은 브라우저의 다른 탭에서 바꾸면 `storage` 이벤트로 즉시 반영한다.
- 첫 렌더 전에 적용해 색이 깜빡이는 시간을 줄인다.
- 로그아웃해도 유지된다(화면 설정일 뿐 세션·키와 무관).

## 2. 구현

| 위치 | 역할 |
|---|---|
| `client/src/index.css` | `--accent-base` 프리셋과 `@theme inline` 의 `accent-50~950` 팔레트 |
| `client/src/lib/theme.ts` | 프리셋 정의, 저장값 검증, `html[data-accent]` 적용 |
| `client/src/components/AccentPicker.tsx` | 강조색 선택 UI(다른 탭 동기화 포함) |
| `client/src/pages/DevicesPage.tsx` | "화면 설정" 카드 |
| `client/src/main.tsx` | 첫 렌더 전 초기 적용 |

- 기존 `violet-*` 유틸리티를 **`accent-*`** 로 통일해 모든 화면이 같은 강조색을 따른다.
- shade 는 `color-mix(in oklab, var(--accent-base) …, white|black)` 로 파생한다.
  - CSS `color-mix` 를 지원하는 최신 브라우저를 대상으로 한다.
- 프리셋의 600 계열은 흰 글자와 대비가 충분한 색으로 골랐다.

## 3. 검증

- `client/src/lib/theme.test.ts`: 알 수 없는 값의 기본값 fallback, 프리셋 ID 유일성·색상 형식
- 프로덕션 빌드에서 `bg-accent-600` 등이 `var(--accent-base)` / `color-mix(...)` 로 생성되는지 확인

## 4. 한계

- 브라우저·프로필별 설정이라 다른 기기와 자동으로 동기화되지 않는다.
- PWA 아이콘·매니페스트의 `theme_color` 는 바꾸지 않는다(브라우저 UI 색은 그대로).
- 관리자 콘솔도 같은 강조색을 따른다(별도 테마 없음).
- `localStorage` 를 지우면 기본값(바이올렛)으로 돌아간다.
