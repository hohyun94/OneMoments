# 대화 초안 · 답장 원문 이동 · 업데이트 알림

## 1. 대화별 초안 (임시저장)

| 항목 | 결정 |
|---|---|
| 저장 위치 | `localStorage["onemoments-drafts"]` — `{ [conversationId]: text }` JSON |
| 범위 | **이 브라우저/기기만**. 서버로 전송하지 않는다 |
| 길이 제한 | 4,000자(초과분은 잘라 저장) |
| 삭제 | 빈 문자열이 되면 해당 키 제거, 마지막 초안이면 저장 키 자체 삭제 |
| 로그아웃 | `clearAllDrafts()` — 평문이 남지 않도록 로그아웃/자동 잠금 시 전부 삭제 |

구현: `client/src/lib/drafts.ts` (`loadDraft` / `saveDraft` / `clearDraft` / `clearAllDrafts`,
`Storage` 를 주입받아 단위 테스트 가능). `ChatView` 는 대화가 바뀔 때 초안을 복원하고,
입력이 바뀔 때마다 저장한다. 전송 성공 시 `setDraft("")` → 저장 키가 지워진다.

> 프라이버시: 초안은 기기 로컬에 **평문**으로 남는다. 공용 PC 라면 로그아웃(또는 자동 잠금)으로 정리된다.

## 2. 답장 인용 클릭 → 원문 이동

- `MessageBubble` 의 인용 블록을 `button` 으로 바꿔 `onJumpToTarget(targetMessageId)` 를 호출한다.
- `ChatView` 는 기존 `?anchor=<messageId>` 흐름을 재사용한다: 해당 메시지가 현재 페이지에
  없으면 더 불러오고, 찾으면 스크롤 + `ring` 하이라이트(`setHighlightId`).
- 별도의 스크롤 로직을 새로 만들지 않아 긴 대화/페이지네이션 동작이 검색과 동일하다.

## 3. 새 버전 알림 (PWA)

`sw.js` 는 설치 시 `skipWaiting()` 을 호출하므로, 새 배포가 있으면 열려 있는 페이지의
컨트롤러가 교체된다(`controllerchange`). `client/src/lib/swUpdate.ts` 는

1. 로드 시점에 컨트롤러가 **있었는지**를 기억하고(첫 설치 제외),
2. `controllerchange` 또는 `registration.waiting` 을 감지하면 "새 버전 있음" 상태를 알린다.

`UpdatePrompt`(하단 배너)가 이 상태를 구독해 **새로고침 / 닫기**를 제공한다. 입력 중
강제 리로드를 피하려고 자동 리로드는 하지 않는다. 감지는 `PROD` 빌드에서만 동작하며,
실패해도 앱 사용에는 영향이 없다.

## 4. 자동 삭제 옵션 확장

`AUTO_DELETE_OPTIONS` 에 **1시간**을 추가했다(서버 허용 최소값이 이미 3,600초).

| 값 | 라벨 |
|---|---|
| `null` | 끔 |
| 3,600 | 1시간 |
| 86,400 | 1일 |
| 604,800 | 7일 |
| 2,592,000 | 30일 |

## 5. 테스트

- `client/src/lib/drafts.test.ts` — 대화별 저장/로드, 빈 값 삭제, 손상된 JSON 무시, 길이 제한
- 브라우저 E2E — 초안 입력 → 새로고침 후 복원 → 전송 → 새로고침해도 비어 있음
