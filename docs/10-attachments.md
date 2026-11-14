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

## 3. API

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/conversations/:id/attachments` | `application/octet-stream` 암호문 업로드. 참여자만, CSRF 필요 |
| GET | `/api/attachments/:attachmentId` | 참여자만 암호문 다운로드. `attachment.bin` 이름으로 반환 |

오류: `PAYLOAD_TOO_LARGE`(413), `UNSUPPORTED_MEDIA_TYPE`(415), `EMPTY_ATTACHMENT`(400),
`ATTACHMENT_NOT_FOUND`(404), 비참여자 `CONVERSATION_NOT_FOUND`(404).

## 4. UI

- 입력창 옆 종이클립 버튼 → 파일 선택
- 전송 전 파일 이름·크기 칩, 제거 버튼
- 메시지 말풍선에 파일 카드(이름·크기·`종단간 암호화`)와 **다운로드** 버튼
- 다운로드 시 브라우저에서 복호화해 Blob 으로 저장하며, 서버가 준 파일명이 아니라 **메시지에 암호화된 원래 파일명**을 사용
- 캡션(메시지 텍스트)을 함께 보낼 수 있다

## 5. 한계·운영

- **첨부는 DB 밖에 있다.** PostgreSQL 백업과 `ATTACHMENT_DIR`(compose `attachments` 볼륨)을 함께 백업해야 한다.
  `docs/07-backup-restore.md` 참고.
- 업로드 후 메시지 전송이 실패하면 **고아 암호문**이 남을 수 있다. 주기적 정리 작업은 아직 없다.
- 첨부 ID는 암호화된 메시지에만 있어 서버가 메시지↔첨부를 연결하지 않는다(메타데이터 최소화).
  대신 같은 대화 참여자면 ID를 아는 경우 다운로드할 수 있다(UUID 추측 불가).
- 사진 미리보기·스트리밍·Range 요청은 없다(최대 8MB 전체 메모리 로드).
- 악성코드 검사는 하지 않는다(E2E라 서버가 내용을 볼 수 없음). 다운로드 후 사용자 책임.
- 파일 크기·업로드 횟수 제한은 있지만 사용자별 저장 용량 쿼터는 없다.
- 첨부를 참조하는 메시지를 숨겨도 블롭은 남는다.

## 6. 검증

- 서버: 참여자 다운로드/비참여자·비인증 차단, 크기·Content-Type·빈 파일 검증, 그룹 참여자 다운로드
- 클라이언트: 암복호화 왕복, 다른 키 거부, 메타데이터 인코딩/파싱, 빈/대용량 거부
- E2E: 파일 첨부 전송 → 상대 다운로드 → **복호화 내용 일치**, DB에 파일명·내용 없음, 디스크 블롭에 평문 없음
