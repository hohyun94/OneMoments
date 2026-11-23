# 파일 첨부

파일도 메시지와 같은 원칙을 따른다. **클라이언트가 암호화하고, 서버는 암호문 블롭만 저장**한다.

## 1. 흐름

1. 보내는 사람이 파일 선택 (클라이언트 5MB 이하)
2. 브라우저가 **파일별 1회용 AES-256-GCM 키** 생성 → 파일 암호화
3. `POST /api/conversations/:id/attachments` 로 **암호문만** 업로드 (`application/octet-stream`)
4. 서버는 UUID 파일명으로 저장하고 `attachments` 행(대화·업로더·크기)만 만든다
5. 클라이언트가 메시지 본문에 아래 메타데이터를 넣어 기존 E2E 메시지로 전송
   - `id`, `name`, `mime`, `size`, `key`, `iv`, `text`
6. 메시지는 기존 기기별 봉투로 암호화되므로 **파일 키는 참여자 기기만** 얻는다
7. 받는 사람은 메시지를 복호화해 메타데이터를 얻고, `GET /api/attachments/:id` 로 암호문을 받아 복호화·다운로드한다

메시지 본문 형식(암호화 전):

```text
onemoments:attachment:v1:<base64(JSON)>
{ "id": "...", "name": "회의록.txt", "mime": "text/plain", "size": 1234,
  "key": "<base64 AES-256 key>", "iv": "<base64 12B nonce>", "text": "설명" }
```

## 2. 서버가 아는 것 / 모르는 것

| 구분 | 내용 |
|---|---|
| 저장 | 암호문 블롭, 크기, 대화 ID, 업로더 ID, 생성 시각 |
| 모름 | 파일 이름, MIME, 파일 키, 내용 |
| 접근 제어 | 대화 참여자만 다운로드 (세션 필요) |
| 경로 | `ATTACHMENT_DIR/<attachmentId>.bin` (UUID만 사용) |
| 크기 제한 | 클라이언트 5MB, 서버 암호문 `ATTACHMENT_MAX_BYTES` 기본 8MB |

## 3. 저장소

| 항목 | 로컬(기본) | S3 호환 |
|---|---|---|
| 설정 | `ATTACHMENT_STORAGE=local` | `ATTACHMENT_STORAGE=s3` |
| 경로 | `ATTACHMENT_DIR/<id>.bin` | `s3://<bucket>/attachments/<id>.bin` |
| 자격 | 파일 시스템 볼륨 | IAM 역할 또는 `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` |
| 엔드포인트 | - | `S3_ENDPOINT`(MinIO/R2 등), `S3_FORCE_PATH_STYLE` |

- 업로드 시 `x-attachment-client-message-id` 헤더로 메시지와 예약 연결한다.
- 메시지가 저장되면 서버가 `attachments.message_id`를 채운다(파일 내용·이름은 여전히 모른다).
- `pnpm attachments:cleanup`은 **메시지에 연결되지 않은 채 TTL이 지난 업로드**만 삭제한다.
  - `ATTACHMENT_TTL_DAYS` 기본 30일.
  - 구버전(연결 정보 없는) 첨부는 삭제 대상이 아니다.
- S3를 쓰면 로컬 `attachments` 볼륨은 필요 없지만, DB 백업은 여전히 필요하다.

## 4. API

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/conversations/:id/attachments` | `application/octet-stream` 암호문 업로드. 참여자만, CSRF 필요 |
| GET | `/api/attachments/:attachmentId` | 참여자만 암호문 다운로드. `attachment.bin` 이름으로 반환 |

오류: `PAYLOAD_TOO_LARGE`(413), `UNSUPPORTED_MEDIA_TYPE`(415), `EMPTY_ATTACHMENT`(400),
`ATTACHMENT_NOT_FOUND`(404), 비참여자 `CONVERSATION_NOT_FOUND`(404).

## 4. UI

- 입력창 옆 종이클립 버튼 → 파일 선택, **메시지 영역으로 드래그&드롭**, **입력창에 이미지 붙여넣기** 모두 같은 검증 경로를 쓴다.
- **한 번에 최대 5개**까지 선택할 수 있고, **파일마다 별도 메시지로 전송**한다(첫 파일에 캡션·답장 연결). 각 파일 이름은 전송 전에 수정할 수 있다.
- 전송 전 파일 이름·크기 칩, 제거 버튼. **파일 이름은 칩에서 직접 수정할 수 있다**
- 브라우저/OS가 원본 파일명을 주지 못하면(예: Android content:// 선택, 다른 앱의 캐시 파일
  → `tmp_<uuid>.png`) `첨부-YYYYMMDD-HHMM.<ext>` 기본 이름으로 채우고 안내 문구를 보여준다.
  원본 이름은 브라우저가 이미 잃어버린 값이라 복원할 수 없으므로 사용자가 고쳐 보낸다.
- 메시지 말풍선에 파일 카드(이름·크기)와 **다운로드 아이콘 버튼**(텍스트 없이, `aria-label`/툴팁은 "다운로드")
- **이미지 MIME은 복호화 후 인라인 미리보기**(`blob:`), 클릭하면 새 탭에서 크게 보기
- 다운로드 시 브라우저에서 복호화해 Blob 으로 저장하며, 서버가 준 파일명이 아니라 **메시지에 암호화된 원래 파일명**을 사용
- 캡션(메시지 텍스트)을 함께 보낼 수 있다

## 4-1. 음성 메시지

- 입력창의 **마이크 버튼** → `MediaRecorder` 로 녹음(Opus/WebM 우선, Safari 는 m4a) → **최대 5분**에서 자동 종료.
- 완료하면 파일 1개로 첨부 목록에 들어가고, 기존 첨부 파이프라인(1회용 AES-GCM 키 → 암호문 업로드 → 메시지 봉투)을 그대로 쓴다.
- 파일 이름(`음성-YYYYMMDD-HHMM.webm`), MIME, **길이(초)** 는 모두 메시지 암호문 안에만 있다.
- 음성 카드는 **한 줄 컴팩트 레이아웃**이다: `[재생/일시정지] [파형(클릭=이동)] [경과/길이 · 파일명 · 용량] [다운로드 아이콘]`.
  네이티브 `<audio controls>` 는 위아래 여백이 커서 쓰지 않고, `<audio>` 는 숨긴 채 커스텀 버튼으로 제어한다
  (WebM 길이가 `Infinity` 인 브라우저에서는 암호문에 담긴 길이로 진행 표시·이동을 계산).
  - CSP 는 `media-src 'self' blob:` 를 허용해야 재생된다(없으면 브라우저가 Blob 미디어를 차단). `img-src` 의 `blob:` 와 같은 이유다.
  - 회귀 방지: 서버 테스트가 CSP 헤더를 검사하고, E2E 는 실제 녹음 후 `audio.duration > 0`, 재생 버튼으로 `currentTime` 진행, 카드 높이(<90px)를 확인한다.
- 복호화한 Blob URL 은 메시지가 화면에서 사라질 때 해제한다.
- **파형**: 송신자가 녹음 직후 8kHz 로 한 번만 디코딩해 0~100 피크 48개를 만들고, 그 값을 **암호문 페이로드**에 담는다. 수신자는 다시 디코딩하지 않고 막대를 그리며, 막대를 클릭하면 해당 위치로 이동한다.
- **서버 변경·트랜스코딩 없음**(암호문만 저장), 푸시 문구도 그대로(내용 미포함).
- 한계: Range/스트리밍이 없어 재생 시 전체 파일을 복호화해 메모리에 올린다(5분·5MB 제한으로 완화).

## 4-2. 부분 다운로드(HTTP Range)

`GET /api/attachments/:attachmentId` 가 **암호문 그대로** Range 요청을 지원한다(서버는 복호화하지 않는다).

| 항목 | 동작 |
|---|---|
| 헤더 | 모든 응답에 `Accept-Ranges: bytes`, `Cache-Control: private, no-store` |
| `Range: bytes=start-end` | `206` + `Content-Range: bytes start-end/total` |
| `Range: bytes=start-` | 끝까지 |
| `Range: bytes=-N` | 마지막 N 바이트 |
| 만족 불가 범위 | `416` + `Content-Range: bytes */total` |
| 저장소 | 로컬 파일은 `open`+`read(position)`, S3 는 `GetObject Range` 로 전달 |

- 클라이언트는 아직 **전체를 받아 한 번에 복호화**한다(청크 암호화 + MSE 스트리밍 재생은 후속 설계).
- Range 는 재시도·부분 다운로드·향후 스트리밍 파이프라인의 토대이며, 참여자 검증은 모든 요청에 동일하게 적용된다.

## 4-3. 삭제 정책 (메시지 ↔ 첨부 블롭)

첨부는 **메시지에 연결된 뒤에만** 삭제 정책의 영향을 받는다. 서버는 파일 이름·MIME·길이를 모르므로,
"음성 삭제"도 다른 첨부와 완전히 같은 경로로 처리된다.

| 동작 | API | 저장소 블롭 | `attachments` 행 | 메시지 행 | 비고 |
|---|---|---|---|---|---|
| 모두에게서 전송 취소 | `DELETE …/messages/:id?scope=all` | **삭제** | **삭제** | **삭제** | **발신자만** 가능(받은 메시지는 `403`) |
| 나에게서만 삭제 | `DELETE …/messages/:id?scope=me` | 유지 | 유지 | 유지 | 내 계정에 숨김 기록(`message_deletions`)만 추가 |
| 대화 자동 삭제(N일) | 스케줄러 | **삭제** | **삭제** | **삭제** | `deleteMessagesAndArtifacts()` 공용 |
| 업로드만 되고 전송 실패(고아) | `pnpm attachments:cleanup` | **삭제** | **삭제** | — | `messageId` 없음 + `ATTACHMENT_TTL_DAYS`(기본 30일) 경과분만 |
| 계정 삭제(일반 대화) | `DELETE /api/auth/account` | 유지 | 유지 | 유지 | 메시지 보존 정책(상대 이력 유지) |
| 계정 삭제(Moments) | `DELETE /api/auth/account` | **삭제** | — | — | Moments 첨부만 정리 |

구현 위치

- 라우트: `src/routes/conversations.ts` (`scope=me` → `hideMessageForUser`, `scope=all` → `deleteMessagesAndArtifacts`)
- 삭제: `src/services/autoDelete.ts` `deleteMessagesAndArtifacts()` — **저장소 블롭 삭제 후** 트랜잭션에서 첨부 행·메시지 행 삭제
- 저장소: `src/services/attachments.ts` — 로컬 파일 `removeAttachmentBlob()` 또는 S3 `DeleteObject`

주의

- **이미 내려받은 사본은 회수할 수 없다.** 서버에서 지우면 이후 다운로드만 `404` 가 된다.
- DB+첨부 저장소를 함께 백업하므로 **백업을 복원하면 삭제한 첨부가 되살아날 수 있다**(`docs/06-operations.md` 6절).
- `storage.delete()` 실패는 무시되고 DB 행은 지워진다 → 드물게 **고아 블롭**이 남을 수 있다(고아 정리 잡은 행 기준이라 대상 아님).
- 삭제는 즉시·비가역이다(휴지통 없음).

## 5. 한계·운영

- **첨부는 DB 밖에 있다.** PostgreSQL 백업과 첨부 저장소(로컬 `ATTACHMENT_DIR` 또는 S3 버킷)를 함께 백업해야 한다.
  `docs/07-backup-restore.md` 참고.
- 업로드 후 메시지 전송이 실패하면 고아 암호문이 남을 수 있다. `pnpm attachments:cleanup`을 주기적으로 실행한다.
- 첨부 ID는 암호화된 메시지에만 있고, 서버는 `clientMessageId → message_id` 연결만 안다(파일 이름·MIME·키는 모른다).
- 사진은 복호화 후 인라인 미리보기(최대 8MB, 전체 메모리 로드)만 지원한다. 서버는 `Range` 를 지원하지만(4-2절) 클라이언트는 여전히 전체를 받아 한 번에 복호화하며, 미디어 스트리밍 재생은 범위에서 제외한다.
- 악성코드 검사는 하지 않는다(E2E라 서버가 내용을 볼 수 없음). 다운로드 후 사용자 책임.
- 파일 크기·업로드 횟수 제한은 있지만 사용자별 저장 용량 쿼터는 없다.
- 첨부를 참조하는 메시지를 숨겨도 블롭은 남는다(4-3절 참고 — "나에게서만 삭제").

## 6. 검증

- 서버: 참여자 다운로드/비참여자·비인증 차단, 크기·Content-Type·빈 파일 검증, 그룹 참여자 다운로드
- 서버: `scope=all` 삭제 시 **저장소 블롭 + DB 행** 동시 삭제, `scope=me` 삭제 시 블롭 유지, CSP `media-src blob:` 허용
- 클라이언트: 암복호화 왕복, 다른 키 거부, 메타데이터 인코딩/파싱, 빈/대용량 거부
- E2E: 이미지 파일 첨부 전송 → 상대 미리보기(`naturalWidth > 0`)·다운로드 → 복호화 내용 일치, DB에 파일명 없음, 디스크 블롭에 평문 없음
