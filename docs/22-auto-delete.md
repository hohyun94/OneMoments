# 읽은 뒤 자동 삭제

대화별 옵션으로, **참여자 모두가 읽은 뒤 일정 기간이 지난 메시지**를 서버에서 삭제한다.

## 1. 동작

- 옵션: **끔(기본) / 1일 / 7일 / 30일** (`conversations.auto_delete_after_read_seconds`)
- 읽음 기준
  - 1:1: 상대가 읽은 뒤
  - 그룹: 메시지 작성 시점에 참여 중이던 **참여자 전원**이 읽은 뒤
- 내가 보낸 메시지와 내 참여 이전 메시지는 읽음 대상이 아니다.
- 마지막 읽은 시각 + 기간이 지나면 다음을 함께 삭제한다.
  - `messages` 행(암호문)
  - `message_keys` 행(기기별 봉투, FK cascade)
  - `attachments` 행과 저장소 블롭(로컬/S3)
  - `message_reads` 행(FK cascade)
- 삭제 전에 삭제되는 메시지를 가리키던 `conversation_reads` 커서를 남은 메시지로 보정한다.
- **한 명이라도 읽지 않은 메시지는 삭제되지 않는다.**
- 클라이언트는 5초 주기 메시지 갱신으로 삭제를 반영하고, 사라진 메시지의 복호화 캐시도 제거한다.

## 2. 저장

| 위치 | 내용 |
|---|---|
| `conversations.auto_delete_after_read_seconds` | 대화별 기간(초). null 이면 끔. CHECK 3600~2592000 |
| `message_reads(message_id, user_id, read_at)` | 메시지별 읽은 시각. PK(message_id, user_id), 메시지 삭제 시 cascade |

- 읽음 처리는 `PUT /api/conversations/:id/read` 시 **커서까지의 메시지**에 대해 한 번에 기록한다.
  - 이미 기록된 읽은 시각은 유지한다(`on conflict do nothing`).
  - 참여 이전 메시지와 내가 보낸 메시지는 기록하지 않는다.
- 기능 도입 이전 메시지는 `message_reads` 가 없을 수 있다. 이 경우 현재 읽음 커서가 메시지에 도달했으면 커서 갱신 시각을 **보수적으로** 사용한다(삭제가 늦어질 수 있음).

## 3. API

| 메서드 | 경로 | 설명 |
|---|---|---|
| PUT | `/api/conversations/:conversationId/auto-delete` | `{ "seconds": 3600~2592000 \| null }` |

- 세션 + CSRF 필요. 대화 요약(`GET /api/conversations`, `GET /api/conversations/:id`)에 `autoDeleteAfterReadSeconds` 가 포함된다.
- 그룹은 **owner만** 변경할 수 있고, 1:1은 참여자 누구나 변경할 수 있다(상대에게도 적용).

## 4. 실행

- **조회 시 lazy 실행**
  - `GET /api/conversations` : 전체 정리, 5분에 한 번
  - `GET /api/conversations/:id/messages` : 해당 대화 정리, 1분에 한 번
- **스케줄 실행(권장)**
  ```bash
  pnpm build
  pnpm messages:cleanup   # scripts/cleanup-messages.mjs
  ```
  Coolify 예약 작업 등에서 1시간 주기로 실행한다. 스크립트는 삭제 건수만 JSON 한 줄로 남기며 메시지 ID·내용·키를 남기지 않는다.
- 여러 인스턴스에서 동시에 실행해도 삭제는 멱등이지만, 스케줄은 한 곳에서만 실행하는 것을 권장한다.

## 5. 검증

- `test/auto-delete.test.ts`
  - 옵션 저장·검증·owner 권한
  - 메시지별 읽음 시각 기록(중복 없음)
  - 1:1 전원 읽음 후 삭제, 미읽음이면 보관
  - 그룹 전원 읽음 기준, 이후 참여자는 제외
  - 첨부 행·블롭 동시 삭제
  - 조회 시 lazy 정리
  - 옵션 꺼짐 상태에서 미삭제

## 6. 한계

- 읽지 않은 참여자가 있으면 계속 보관된다.
- 삭제는 주기 정리·조회 시점에 실행되므로 최대 몇 분 지연될 수 있다.
- 이미 내려받았거나 화면에 표시된 내용, 화면 캡처는 회수할 수 없다.
- 클라이언트가 변조되면 이미 받은 평문을 보관할 수 있다(정직한 클라이언트 기준 삭제).
- **백업 복원 시** 백업 시점의 삭제 전 메시지가 되살아날 수 있다. 삭제 정책과 백업 보존 기간을 함께 검토해야 한다.
