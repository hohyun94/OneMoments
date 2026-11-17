# 자동 로그아웃(무활동 잠금)

사용자가 일정 시간 동안 조작하지 않으면 자동으로 로그아웃해 **화면에 남은 대화 내용을 제거**한다.

## 1. 동작

- **무활동 시간**은 **기기별 기본값(기본 5분)** 과 **세션 오버라이드**로 결정한다. 허용 범위는 **1~30분**이며 **끄기(무제한)는 허용하지 않는다**.
- 세션 오버라이드가 있으면 그 값이 우선하고, 없으면 기기 기본값을 따른다.
- 기기 기본값은 `devices.idle_timeout_seconds`, 세션 오버라이드는 `sessions.idle_timeout_seconds` 에 저장한다.
- 같은 기기에서 다시 로그인하면 세션이 회전하므로 **세션 오버라이드는 초기화**되고 기기 기본값으로 돌아간다.
- 설정을 변경하면 타이머가 현재 시각 기준으로 다시 시작된다.
- 활동 감지: 포인터, 키보드, 터치, 스크롤, 휠, 마우스 이동
- 탭이 백그라운드에 있다가 시간이 지나 돌아오면 즉시 로그아웃
- 로그아웃 시:
  - 서버 세션 종료 요청
  - 브라우저 푸시 구독 해제
  - `identity`·`session` 메모리 상태 제거
  - React Query 캐시 제거
  - 복호화된 메시지/첨부 메타데이터 메모리 캐시 제거
  - 로그인 화면으로 즉시 전환
- 로그아웃 후에는 `localStorage`의 강제 로그인 플래그로 새로고침해도 자동 복원하지 않는다.
  - 다시 로그인하면 플래그가 제거된다.

## 2. API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/devices` | 내 기기 목록(각 기기의 `idleTimeoutSeconds` 포함) |
| PUT | `/api/devices/:deviceId/timeout` | `{ "seconds": 60~1800 }` — 이 기기의 기본값 변경 |
| GET | `/api/auth/me` | `idleTimeoutSeconds`(적용값), `deviceIdleTimeoutSeconds`, `sessionIdleTimeoutSeconds` |
| PUT | `/api/auth/session/timeout` | `{ "seconds": 60~1800 \| null }` — 이번 로그인에만 적용, `null` 은 해제 |

- 모두 세션 + CSRF 가 필요하다. 기기 변경은 **본인 소유의 활성 기기만** 가능하고, 다른 사용자의 기기는 `404 DEVICE_NOT_FOUND` 로 응답한다.
- 로그인·가입·복구 응답에는 그 기기의 `idleTimeoutSeconds` 가 포함된다(새 세션이므로 오버라이드는 없다).
- 서버는 범위를 검증하며, 범위를 벗어나면 `400 VALIDATION_ERROR` 를 반환한다.

## 3. 코드

| 위치 | 역할 |
|---|---|
| `src/auth/idleTimeout.ts` | 기본값(300초)·최소/최대(60/1800초)·보정 함수 |
| `src/db/schema.ts` | `devices.idle_timeout_seconds`, `sessions.idle_timeout_seconds` + CHECK 제약 |
| `src/routes/devices.ts` | 기기 기본값 변경 API |
| `src/routes/auth.ts` | 세션 오버라이드 API, `me` 응답의 적용값 계산 |
| `client/src/lib/idleTimeout.ts` | 클라이언트 기본값·범위·보정·라벨 |
| `client/src/session.tsx` | idle 타이머(적용값), 설정 API 호출, 강제 로그인 플래그 |
| `client/src/pages/DevicesPage.tsx` | 기기 기본값·세션 오버라이드 UI |
| `client/src/components/MessageBubble.tsx` | 복호화 평문 캐시 + `clearDecryptedMessageCache()` |
| `client/src/realtime.tsx` | ChatPage unmount 시 WebSocket 정리 |

## 4. 검증

- 서버 `test/api-idle-timeout.test.ts`: 기본값 5분, 기기별 변경, 세션 오버라이드/해제, 재로그인 시 초기화, 범위 검증, 소유권, CSRF
- 클라이언트 `client/src/lib/idleTimeout.test.ts`: 범위 보정·세션 우선순위·라벨
- E2E `auto-logout`: 기본 5분 가상 시계 시나리오 유지

## 5. 한계

- 화면 캡처·OS 알림·개발자도구·기기 포렌식까지 막지는 못한다.
- IndexedDB의 E2E 키는 로그아웃 후에도 남는다(재로그인·이력 복호화에 필요).
- 실제로 기기 전체를 잠그려면 OS 잠금/화면 잠금과 함께 사용해야 한다.
- **설정값은 서버가 강제하지 않는다.** 서버는 설정 저장과 범위 검증만 담당하고, 실제 무활동 로그아웃은 브라우저 타이머가 수행한다. 악의적 클라이언트는 타이머를 무시할 수 있으므로 물리적 기기 보호는 OS 잠금과 함께 사용한다.
- 다른 탭에서 변경한 설정은 그 탭에 즉시 반영되지 않는다(새로고침·재로그인 시 반영).
- 자동 로그아웃 중 네트워크 오류가 나도 로컬 강제 로그인 플래그로 화면 복원은 막는다.
