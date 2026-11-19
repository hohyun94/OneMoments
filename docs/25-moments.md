# Moments (24시간 스토리)

선택한 사람에게만 **24시간** 공개되는 텍스트·이미지 스토리. 내용은 E2E 암호문으로만 저장되고, 서버는 대상자·조회 메타데이터만 보관한다.

## 1. 동작

- 작성: 로그인 후 **사이드바 → Moments → 순간 공유**
- 공개 범위: **내가 참여 중인 대화의 상대** 중 선택한 사람(최대 50명)
- 형식: 텍스트 + 이미지 1장(5MB 이하), 둘 중 하나만 있어도 됨
- 만료: 생성 후 **24시간**, 만료된 스토리는 피드·상세·첨부 접근에서 제외되고 정리 작업이 삭제
- 작성자: 조회한 사람 목록과 조회 수 확인, 스토리 삭제 가능
- 조회자: 피드에서 열람 시 조회 기록(사용자별 최초 1회)
- 계정 삭제 시 작성한 스토리와 업로드한 이미지 블롭도 함께 삭제한다.
- 실시간 푸시/WS는 v1 범위外 — 피드는 30초 폴링

## 2. E2E 흐름

1. 클라이언트가 `momentId`(UUID)를 생성한다.
2. 이미지가 있으면 파일별 AES-GCM으로 암호화해 `/api/moments/attachments`에 업로드한다(서버는 암호문만 저장).
3. 본문(텍스트 또는 이미지 메타데이터)을 `momentId`를 conversationId/clientMessageId로 사용해 기존 봉투 경로로 암호화한다.
4. 공개 대상 + 내 기기의 **활성 기기별 봉투**를 만들어 `POST /api/moments`로 전송한다.
5. 서버는 암호문·봉투·대상 목록·만료 시각만 저장한다.

- 서버가 보는 것: 작성자/기기, 공개 대상 사용자 ID, 내 기기 봉투, 조회자 ID/시각, 만료 시각
- 서버가 못 보는 것: 텍스트, 이미지 파일명·MIME·키, 이미지 내용
- 새 기기로 로그인하면 **이후 스토리만** 복호화할 수 있다(기존 스토리 봉투 없음).

## 3. 데이터 모델

| 테이블 | 내용 |
|---|---|
| `moments` | id(클라이언트 생성), author_user_id/device_id, author_signing_public_key, ciphertext/nonce/signature, expires_at, created_at |
| `moment_audience` | moment_id, user_id (공개 대상) |
| `moment_keys` | moment_id, recipient_device_id, v1/v2 봉투 필드 |
| `moment_views` | moment_id, viewer_user_id, viewed_at |
| `moment_attachments` | id, uploader_user_id, client_moment_id, moment_id, size, last_accessed_at |

- `moments` 삭제 시 대상·봉투·조회·첨부 행이 cascade 삭제된다.
- 첨부 블롭은 삭제 서비스가 DB 삭제 전에 함께 제거한다.

## 4. API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/moments/contacts` | 내 대화 상대 + 각자의 활성 기기 공개키/프리키 + 내 기기 목록 |
| POST | `/api/moments/attachments` | 암호화 이미지 업로드(`x-moment-id` 헤더), `{attachment:{id,size}}` |
| GET | `/api/moments/attachments/:id` | 작성자 또는 공개 대상만 다운로드(만료 시 404) |
| POST | `/api/moments` | `{id, audienceUserIds, ciphertext, nonce, signature, keys, attachmentId?}` |
| GET | `/api/moments/feed` | 내가 작성했거나 대상인 활성 스토리 |
| GET | `/api/moments/:id` | 상세(내 기기 봉투 포함) |
| POST | `/api/moments/:id/view` | 조회 기록(작성자 제외) |
| GET | `/api/moments/:id/views` | 작성자만 조회자 목록 |
| DELETE | `/api/moments/:id` | 작성자만 삭제 |

- 모두 세션 필요, 상태 변경은 CSRF 필요.
- 대상 검증: 공개 대상은 내가 참여한 대화의 상대여야 하고, 각 대상에 최소 1개 기기 봉투가 필요하다.
- 봉투 대상은 작성자/선택된 대상의 활성 기기로 제한한다. v2 OPK는 메시지와 동일하게 1회 소비한다.

## 5. 만료·정리

- 조회 시 lazy 정리(60초 throttle)와 `pnpm moments:cleanup` 스크립트를 함께 사용한다.
- 스크립트는 만료 스토리와 연결되지 않은 오래된 업로드를 삭제하고 건수만 로그로 남긴다.
- Coolify 예약 작업 등에서 **1시간 주기** 실행을 권장한다.

## 6. 검증

- 서버 `test/api-moments.test.ts`
  - 연락처/기기 조회, E2E 복호화, 공개 범위(대상/비대상), 조회 기록·작성자 조회 목록
  - 작성자만 삭제, 대상 아닌 사용자 404
  - 이미지 첨부 업로드/다운로드 권한
  - 만료 정리(스토리·첨부 블롭 삭제)
- 클라이언트 `client/src/lib/moments.test.ts`: 만료 라벨, 본문/첨부 메타데이터 파싱
- E2E는 환경에 Chrome이 없어 미실행

## 7. 한계

- 서버에 **공개 대상·조회자·조회 시각** 메타데이터가 남는다(내용은 비밀).
- 실시간 알림/WS 갱신은 없다(30초 폴링).
- 동영상·다중 이미지·음성은 v1 범위外.
- 새 기기는 이전 스토리를 복호화할 수 없다.
- 이미 내려받은 이미지·화면 캡처는 회수할 수 없다.
- 만료 정리는 크론/조회 시점에 실행되므로 최대 수십 분 지연될 수 있다.
