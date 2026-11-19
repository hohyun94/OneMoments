# 아키텍처·보안 설계 — OneMoments

> 기획 단계 초안. 구현 전에 결정이 필요한 항목은 문서 끝에 모아 둔다.

## 시스템 구성

```
[브라우저 A]                                     [브라우저 B]
 ├─ UI (React)                                    ├─ UI (React)
 ├─ 기기 키 보관(IndexedDB)                        ├─ 기기 키 보관(IndexedDB)
 ├─ 암복호화(WebCrypto + 필요 시 @noble/curves)     ├─ 암복호화
 └─ REST / WebSocket (HttpOnly 세션 쿠키)          └─ REST / WebSocket
        │                                                │
        └──────────────► [OneMoments 서버] ◄──────────────┘
                          ├─ 인증·세션, 기기·공개키
                          ├─ 대화·메시지(암호문) 저장
                          ├─ WebSocket 중계
                          └─ PostgreSQL (암호문 + 메타데이터)
```

서버의 역할은 **암호문과 공개키의 보관·중계**다. 평문·대화 키·기기 개인키는 서버에 존재하지 않는다.

## E2E 암호 설계

### 기기 키

| 키 | 알고리즘 | 용도 | 서버 저장 |
|---|---|---|---|
| `IK` (신원 키) | X25519 | 메시지 키 봉투(ECDH) | 공개키만 |
| `SK` (서명 키) | Ed25519 | 메시지 발신자 인증 | 공개키만 |

- 브라우저에서 생성하고 IndexedDB에 보관한다. 키 백업(복구)을 위해 private `CryptoKey`는 **extractable**로 보관하며,
  XSS 위험은 엄격한 CSP·서드파티 스크립트 금지로 완화한다.
- WebCrypto의 X25519/Ed25519 지원이 없는 브라우저는 `@noble/curves`로 폴백한다(이 경우 키 보관 방식은 별도 결정).

### Double Ratchet (v2 봉투)

- 대화 × 기기 쌍마다 **독립 세션**을 둔다. 세션은 루트 키, 송·수신 체인 키, DH ratchet 키 쌍, 카운터, 건너뛴 메시지 키를 가진다.
- 세션 초기화는 상대의 정적 X25519 공개키를 첫 DH ratchet 키로 사용한다(X3DH/사전 키는 아직 없음).
- 메시지마다 체인에서 message key를 유도해 **콘텐츠 키를 래핑**하고, 헤더(`ratchetPublicKey`, `previousChainLength`, `messageNumber`)를 봉투에 넣는다.
- 상대가 새 DH 공개키를 보내면 DH ratchet을 수행하고, 순서가 뒤바뀐 메시지는 **건너뛴 키(최대 1000개)** 로 복호화한다.
- 발신자 자신의 기기 봉투는 v1(정적 키)을 유지해 즉시 표시·복구를 단순화한다.
- 이력 복호화를 위해 사용한 message key를 로컬 `historyKeys`에 저장하고, 키 백업에 세션·이력 키를 함께 넣는다.
- 상세: `docs/11-double-ratchet.md`

### 메시지 전송 절차

1. 발신 기기: 32바이트 콘텐츠 키 `K`, 12바이트 `nonce` 생성 → `AES-256-GCM(K, nonce, plaintext)` → `C`(+태그)
2. 발신 기기: `conversationId`, `clientMessageId`, `C`의 해시를 `SK`로 **서명** → `sig`
3. 수신자(상대 사용자 + 내 다른 기기)의 **활성 기기마다**:
   - v2(기본): 해당 대화·기기 세션에서 message key `MK` 유도 → `AES-256-GCM(MK, wrap_nonce, K)` → `W`
     헤더 `{ ratchetPublicKey, previousChainLength, messageNumber }` 포함
   - v1(내 기기·레거시): 임시 X25519 ECDH + HKDF KEK로 `K` 래핑
4. 서버 전송: `{ ciphertext: C, nonce, signature: sig, keys: [{ deviceId, version, ...헤더, wrapNonce, wrappedKey: W }] }`
5. 발신 기기는 사용한 message key/chain을 전진시키고 이전 키를 폐기한다(v1 임시 키도 폐기).

### 수신 절차

1. 수신 기기: 자신의 `deviceId` 봉투를 받는다
2. v2: 로컬 이력 키가 있으면 재복호화(새로고침·백업 복구). 없으면 세션을 전진/래칫해 `K` 복원
   - 새 DH 공개키 → 필요 시 건너뛴 키 저장 → DH ratchet → message key
   - 서명을 먼저 검증해 변조 메시지가 세션 상태를 소모하지 않게 한다
3. v1: `ECDH(recipient_IK_priv, E)` → `KEK` → `K`
4. `AES-256-GCM(K, nonce, C)` 복호화 후 발신 기기 `SK_pub`으로 서명 검증

### 안전번호(safety number)

- 두 사용자의 **활성 기기 공개키(IK+SK)** 로 계산한다.
  - 사용자별: 기기 키를 정렬해 `userId + 키 목록`을 SHA-256
  - 사용자 ID 순으로 정렬한 뒤 다시 SHA-256 → 60자리(5자리 × 12그룹)로 표시
- 기기 추가·폐기로 지문이 바뀌면 **경고 배너**를 띄우고, 사용자가 확인하면 새 번호를 저장한다(TOFU).
- 마지막으로 확인한 번호는 브라우저(localStorage)에 대화별로 저장한다.
- 서버는 안전번호 계산에 관여하지 않는다.

### 보장과 한계

| 항목 | 보장 | 비고 |
|---|---|---|
| 기밀성 | 서버·DB·백업에 평문 없음 | 메타데이터는 노출 |
| 무결성 | AES-GCM + Ed25519 서명 | 서버가 변조하면 복호화·검증 실패 |
| 발신자 인증 | 기기 서명 + 안전번호 | 서버가 발신자를 사칭할 수 없음 |
| 순방향 비밀성(FS) | **수신 v2 메시지에 적용** | 체인 키 폐기 + DH ratchet, 건너뛴 키 최대 1000 |
| 기기 키 침해 시 과거 메시지 | **수신 DR 이력은 보호** | 단, 로컬 이력 키/백업, 발신자 자신의 v1 봉투는 예외 |
| 새 기기의 과거 이력 | **백업 스냅샷까지** | 백업에 DR 세션·이력 키 포함, 이후 메시지는 재백업 필요 |

> 초기 핸드셰이크는 상대의 정적 키를 사용한다(X3DH·서명된 사전 키 없음). 따라서 **첫 DH ratchet 이전** 메시지는 상대 정적 키 침해에 취약하고, 이후 체인은 래칫된다. 상세 한계는 `docs/11-double-ratchet.md`.

## 데이터 모델 (초안)

| 테이블 | 주요 컬럼 | 설명 |
|---|---|---|
| `users` | id(uuid), username(unique, 소문자), password_hash, status_message, theme_mode(light\|dark\|system), theme_accent(프리셋\|#rrggbb), created_at, deleted_at | 계정. 이메일 미수집(MVP). 삭제 시 익명화. 상태 메시지는 **공개 프로필 메타데이터(평문, 최대 80자)** 이며 메시지 암호화 대상이 아니다. 테마는 계정 동기화용 메타데이터 |
| `user_blocks` | blocker_user_id, blocked_user_id, created_at (PK) | 1:1 차단 메타데이터. 차단자/대상만 저장하며 메시지 내용은 저장하지 않는다. 양방향 전송 차단에 사용 |
| `user_favorites` | user_id, favorite_user_id, created_at (PK) | 연락처 즐겨찾기 메타데이터. 대화 목록 정렬에만 사용 |
| `sessions` | id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent, idle_timeout_seconds | 쿠키 세션(원문 토큰 저장 안 함). idle_timeout_seconds 는 세션 오버라이드(1~30분, null 이면 기기 기본값) |
| `devices` | id, user_id, name, identity_public_key, signing_public_key, idle_timeout_seconds, created_at, last_seen_at, revoked_at | 기기 공개키. idle_timeout_seconds 는 기기 기본 무활동 로그아웃(1~30분, 기본 5분) |
| `conversations` | id, kind('direct'\|'group'), name, auto_delete_after_read_seconds, created_at | 1:1 또는 그룹. 그룹은 name 필수. auto_delete 는 읽은 뒤 자동 삭제(1시간~30일, null 이면 끔) |
| `conversation_participants` | conversation_id, user_id, joined_at, hidden_at, muted_at, role('owner'\|'member') (PK) | 참여자. 그룹 최대 20명, 사용자별 숨김/음소거, 소유자 권한 |
| `messages` | id, conversation_id, sender_user_id, sender_device_id, **sender_signing_public_key**, ciphertext, nonce, signature, client_message_id, kind('text'\|'reaction'\|'edit'), target_message_id, sender_key_id, sender_key_iteration, created_at | 암호문 1건. kind/target 은 반응·수정·답장 메타데이터, 내용은 암호문 안 |
| `message_keys` | message_id, recipient_device_id, wrapped_key, wrap_nonce, ephemeral_public_key, ratchet_public_key, previous_chain_length, message_number, distribution_ciphertext, distribution_nonce, version (PK) | 기기별 봉투(v1/v2), sender-key 최초 배포 블롭 |
| `message_reads` | message_id, user_id, read_at (PK: message_id+user_id) | 메시지별 읽은 시각. 참여자 전원 읽은 뒤 자동 삭제 계산용 |
| `key_backups` | id, user_id, device_id(unique), blob, updated_at | 복구 암호로 암호화된 기기 키 백업(서버는 불투명) |
| `recovery_challenges` | id, device_id, nonce, created_at, expires_at | 기기 복구용 일회용 챌린지 |
| `attachments` | id, conversation_id, uploader_user_id, size, created_at | 암호화된 첨부 블롭 메타데이터(파일명·MIME 없음) |
| `moments` (+`moment_audience`, `moment_keys`, `moment_views`, `moment_attachments`) | moment id, author, audience, 기기 봉투, 조회, 암호화 이미지 | 24시간 선택 공개 스토리. 내용은 암호문, 대상/조회만 메타데이터 |
| `push_subscriptions` | id, user_id, device_id, endpoint(unique), p256dh, auth, failure_count, last_success_at | Web Push 구독(기기별, 로그아웃/폐기 시 삭제) |
| `conversation_reads` | conversation_id, user_id, last_read_message_id, updated_at (PK: conversation_id+user_id) | 사용자별 읽음 커서(읽지 않은 수 계산) |

- 인덱스: `messages(conversation_id, created_at desc)`, `message_keys(recipient_device_id)`.
- 대화 이력 조회는 `messages ⋈ message_keys ON recipient_device_id = 내 기기`로 필요한 봉투만 가져온다.
- 서버는 `ciphertext`·`wrapped_key`의 **형식과 크기**만 검증한다.

### 계정 삭제(익명화) 절차
1. 해당 사용자의 **모든 세션 삭제** → 즉시 로그아웃
2. `devices.revoked_at` 설정. 과거 메시지 서명 검증에 필요한 공개키는 보존
3. `users.deleted_at` 설정, `password_hash` 무효화. username 행은 유지되어 **재사용 불가**(사칭 방지)
4. `messages`·`message_keys` 는 유지 → 상대 UI에서 발신자를 **"삭제된 사용자"** 로 표시
5. 삭제된 사용자와의 대화는 **읽기 전용**(전송 불가)

> 대화 삭제는 `conversation_participants` 에 숨김 표시(예: `hidden_at`)만 남기고 데이터는 유지한다.

### 그룹 대화

- `kind='group'`, 이름(1~64자), 참여자 N명(최대 20명). 상세: `docs/09-groups.md`
- 메시지는 **참여자 전원의 활성 기기마다 봉투**를 만든다(현재는 Sender Keys 아님).
- 참여자 추가 후 기기 집합이 바뀌면 `409 DEVICE_SET_CHANGED` → 클라이언트가 재암호화한다.
- 새 참여자는 참여 이후 메시지만 복호화할 수 있다.

### 파일 첨부

- 파일은 클라이언트에서 파일별 AES-256-GCM 키로 암호화해 업로드한다. 서버는 암호문 블롭만 저장한다.
- 파일 이름·MIME·파일 키는 **메시지 암호문 안**에 넣어 기존 기기별 봉투로 전달한다.
- 다운로드는 대화 참여자만 가능하며, 서버는 `ATTACHMENT_DIR` 의 UUID 파일만 읽는다.
- 상세·한계: `docs/10-attachments.md`

### 푸시 알림

- `push_subscriptions` 에 기기별 Web Push 구독(endpoint, p256dh, auth)을 저장한다.
- 새 메시지 저장 후 참여자 구독으로 **일반 문구 + 대화/메시지 ID만** 비동기 전송한다(발신 기기 제외).
- VAPID ES256 JWT + RFC 8291 aes128gcm. 메시지 내용·발신자·파일 정보는 payload에 넣지 않는다.
- 로그아웃·기기 폐기·계정 삭제 시 구독을 삭제한다. 상세: `docs/12-push-mobile.md`

### Sender Keys (그룹)

- 그룹 신규 메시지는 발신자별 sender key 체인으로 1회 암호화한다.
- 새 기기에는 체인 상태를 DR v2 봉투로 배포하고, 이후 메시지는 봉투 없이 전송한다.
- 참여자 수가 바뀌면 다음 전송에서 새 senderKeyId로 회전한다.
- 1:1은 Double Ratchet(v2)을 유지한다. 상세: `docs/14-sender-keys.md`

### 키 백업·기기 복구

- 복구 암호(PBKDF2-SHA256 600k + AES-256-GCM)로 기기 private 키 + **DR 세션/이력 키**를 클라이언트에서 암호화해 `key_backups` 에 저장한다.
- 새 브라우저는 username으로 블롭을 조회해 복호화하고, 서버가 발급한 **일회용 챌린지**에 기기 Ed25519 서명을 붙여
  `POST /api/auth/recover` 로 **같은 기기 ID** 세션을 얻는다. 이 기기 앞으로 저장된 기존 봉투를 그대로 복호화할 수 있다.
- 복구 시 DR 세션·이력 키를 IndexedDB에 복원해 백업 시점까지의 DR 이력을 읽는다.
- 복구 시 그 기기의 기존 세션은 모두 폐기한다. 폐기된 기기는 복구할 수 없다.
- 자세한 내용과 한계: `docs/08-key-backup.md`

## API 초안

### 인증·세션

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/auth/register` | `{username, password, device:{name, identityPublicKey, signingPublicKey}}` |
| POST | `/api/auth/login` | `{username, password, deviceId?}`. 새 기기는 `device`를 함께 보내 즉시 등록 |
| POST | `/api/auth/logout` | 현재 세션 종료 |
| DELETE | `/api/auth/account` | `{password}` 확인 후 계정 익명화 삭제(세션·기기 무효, 메시지 유지) |
| PUT | `/api/auth/backup` | 복구 암호로 암호화한 기기 키 블롭 저장/갱신 |
| GET | `/api/auth/backup` | 내 기기 백업 조회 |
| POST | `/api/auth/recovery/lookup` | username의 최신 백업 블롭 조회(암호문) |
| POST | `/api/auth/recovery/challenge` | 기기 복구용 일회용 챌린지 발급 |
| POST | `/api/auth/recover` | 챌린지 서명 검증 후 같은 기기 ID로 세션 발급 |
| GET | `/api/auth/me` | 내 정보 + 세션 기기 + 적용 중인 무활동 로그아웃(초) + 계정 테마 |
| PUT | `/api/auth/session/timeout` | `{seconds: 60~1800 \| null}` 이번 로그인에만 적용(null 은 해제) |
| PUT | `/api/auth/theme` | `{mode: light\|dark\|system, accent: 프리셋\|#rrggbb}` 계정 테마 저장 |

- 쿠키: `om_session`(HttpOnly, Secure, SameSite=Lax). 원문 토큰은 DB에 저장하지 않고 해시만 저장.
- 상태 변경 요청은 `Origin` 검사 + CSRF 토큰(더블 서브밋)으로 보호한다.

### 기기·사용자·대화

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/devices` | 내 기기 목록(활성/폐기, 기기별 `idleTimeoutSeconds`) |
| POST | `/api/devices` | 기기 추가(로그인 상태) |
| PUT | `/api/auth/profile` | `{statusMessage: string \| null}` 공개 상태 메시지(최대 80자, 평문 프로필) |
| PUT | `/api/devices/:id/timeout` | `{seconds: 60~1800}` 기기 기본 무활동 로그아웃 변경 |
| DELETE | `/api/devices/:id` | 기기 폐기 → 해당 세션 무효 |
| GET | `/api/contacts` | 대화 상대 목록 + 상태 메시지·즐겨찾기·차단 상태 |
| PUT | `/api/contacts/:userId/favorite` | `{favorite}` 즐겨찾기 설정/해제(대화 상대만) |
| PUT | `/api/contacts/:userId/block` | `{blocked}` 1:1 차단/해제. 차단 시 즐겨찾기 자동 해제 |
| GET | `/api/users/search?username=` | 정확 일치 검색(스로틀) |
| POST | `/api/conversations` | `{peerUserId}`(1:1 재사용) 또는 `{kind:"group", name, memberUserIds}` |
| GET | `/api/conversations` | 대화 목록(최근 메시지 시각, 그룹 이름·인원 포함) |
| GET | `/api/conversations/:id` | 대화 요약(참여자만) |
| POST | `/api/conversations/:id/members` | 그룹 참여자 추가(멱등) |
| DELETE | `/api/conversations/:id/members/me` | 그룹 나가기(마지막 참여자면 대화 삭제) |
| PUT | `/api/conversations/:id/group` | 그룹 이름 변경(참여자) |
| PUT | `/api/conversations/:id/notification` | `{muted}` 대화별 푸시 음소거 |
| PUT | `/api/conversations/:id/auto-delete` | `{seconds: 3600~2592000 \| null}` 읽은 뒤 자동 삭제(그룹은 owner만) |
| PUT | `/api/conversations/:id/read` | `{messageId}` 읽음 커서 전진, `unreadCount` 계산(반응/수정 제외) |
| GET | `/api/conversations/:id/devices` | **대화 참여자 전체** 활성 기기 공개키(암호화 대상 목록) |
| POST | `/api/conversations/:id/attachments` | 암호화된 파일 업로드(`application/octet-stream`) |
| GET | `/api/attachments/:attachmentId` | 참여자만 첨부 암호문 다운로드 |
| GET | `/api/push/public-key` | VAPID 공개키(세션 필요) |
| POST | `/api/push/subscriptions` | Web Push 구독 저장/갱신 |
| DELETE | `/api/push/subscriptions` | 구독 삭제 |
| DELETE | `/api/conversations/:id` | 내 화면에서 숨김 |

### Moments (24시간 스토리)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/moments/contacts` | 내 대화 상대 + 활성 기기 공개키/프리키 |
| POST | `/api/moments/attachments` | 암호화 이미지 업로드(`x-moment-id`) |
| GET | `/api/moments/attachments/:id` | 작성자/공개 대상만 다운로드 |
| POST | `/api/moments` | `{id, audienceUserIds, ciphertext, nonce, signature, keys, attachmentId?}` |
| GET | `/api/moments/feed` | 내가 작성/대상인 활성 스토리 |
| GET | `/api/moments/:id` | 상세 + 내 기기 봉투 |
| POST | `/api/moments/:id/view` | 조회 기록 |
| GET | `/api/moments/:id/views` | 작성자만 조회자 목록 |
| DELETE | `/api/moments/:id` | 작성자만 삭제 |

### 메시지

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/conversations/:id/messages?before=&limit=` | 최신순, 내 기기 봉투만 포함 |
| POST | `/api/conversations/:id/messages` | 아래 본문. `clientMessageId` 멱등 |
| DELETE | `/api/conversations/:id/messages/:messageId` | 발신자만. 봉투·첨부·반응/수정 이벤트 삭제(답장은 target만 해제) |

```jsonc
{
  "clientMessageId": "c-01J...",
  "kind": "text",                   // text | reaction | edit
  "targetMessageId": "uuid",        // 반응·수정·답장의 대상(선택)
  "ciphertext": "base64",          // AES-256-GCM(ciphertext||tag)
  "nonce": "base64",               // 12 bytes
  "signature": "base64",           // Ed25519(conversationId, clientMessageId, sha256(ciphertext))
  "keys": [
    {
      "deviceId": "uuid",
      "ephemeralPublicKey": "base64", // X25519 32 bytes
      "wrapNonce": "base64",          // 12 bytes
      "wrappedKey": "base64",         // AES-256-GCM(KEK, nonce, K)
      "version": 1
    }
  ]
}
```

- 서버는 `keys`의 `deviceId` 집합이 **현재 활성 기기 집합과 정확히 일치**하는지 확인한다.
  불일치 시 `409 DEVICE_SET_CHANGED`와 최신 기기 목록을 반환해 클라이언트가 다시 암호화하게 한다.
- 서버는 봉투 형식·크기·중복만 검증한다.

### WebSocket

`wss://<host>/ws` (세션 쿠키 인증, Origin 검사)

| 방향 | 프레임 |
|---|---|
| C→S | `{type:"subscribe", conversationIds:[...]}` |
| C→S | `{type:"message.send", ...POST와 동일 본문}` |
| C→S | `{type:"typing", conversationId, state}` / `{type:"ping"}` |
| S→C | `{type:"ready"}` / `{type:"subscribed", conversationIds}` |
| S→C | `{type:"message.created", message:{..., kind, targetMessageId, key: 내 기기 봉투}}` |
| S→C | `{type:"message.deleted", conversationId, messageIds[]}` |
| S→C | `{type:"message.ack", clientMessageId, message}` |
| S→C | `{type:"typing"|"presence"}`, `{type:"error", code, message}` |

> `message.created` 는 **대화 참여자의 모든 연결**에 전달된다(구독 전이어도 대화 목록이 즉시 갱신된다).
> 타이핑·presence 는 구독한 대화에만 전달한다.

## 위협 모델

| 위협 | 영향 | 완화 |
|---|---|---|
| 서버 침해 | 암호문·메타데이터 노출 | 평문/키 미보관, 최소 메타데이터 |
| DB·백업 유출 | 위와 동일 | 저장 암호화, 접근 제어, PITR |
| 악성/변조 서버 | 발신자 사칭·메시지 변조 | Ed25519 서명 + AEAD, 안전번호 |
| XSS | 기기 키·평문 탈취 | 엄격한 CSP, 서드파티 스크립트 금지, HttpOnly 쿠키, non-extractable 키 |
| CSRF | 의도치 않은 상태 변경 | SameSite=Lax + Origin 검사 + CSRF 토큰 |
| 세션 탈취 | 계정 접근 | HttpOnly/Secure, 세션 회전, 기기 폐기, 유휴 만료 |
| 무차별 대입 | 계정 탈취 | scrypt/Argon2id, 레이트리밋, 잠금 |
| MITM | 대화 도청 | TLS + 안전번호 대조(TOFU 경고) |
| 기기 도난 | 해당 기기 대화 노출 | OS 잠금, 세션/기기 폐기, 로그아웃 시 키 삭제 |
| 스팸·검색 남용 | 서비스 품질 저하 | 검색/메시지 레이트리밋, 1:1 차단(양방향 전송 차단) |
| 백업 블롭 유출 + 약한 복구 암호 | 오프라인 대입으로 기기 키 복원 | PBKDF2 600k, 10자 이상 권장, `key_backups` 접근 최소화 |
| 백업 복구 악용 | 기기 세션 탈취 | 일회용 챌린지 + Ed25519 서명, 폐기 기기 복구 금지, 기존 세션 폐기 |
| 첨부 블롭 유출 | 파일 내용 노출 | 파일별 AES-GCM, 키는 메시지 암호문 안, 참여자만 다운로드 |
| 첨부 저장소 고갈 | 서비스 장애 | 크기 제한(8MB), 업로드 레이트리밋, 디스크 모니터링 |
| 푸시 구독 메타데이터 노출 | 대화 존재/활동 추론 | payload에 내용 미포함, 엔드포인트 로그 금지 |
| 메타데이터 분석 | 대화 패턴 추론 | 패딩·커버 트래픽은 M4 이후 검토 |

## 기술 선택 (잠정)

| 계층 | 선택 | 비고 |
|---|---|---|
| 웹 | React 19 + Vite + TypeScript | Tailwind + shadcn/ui, TanStack Query, React Router |
| 클라이언트 암호 | WebCrypto(AES-GCM, HKDF) + X25519/Ed25519 | 미지원 브라우저는 `@noble/curves` 폴백 |
| 키 보관 | IndexedDB (`idb`) | non-extractable `CryptoKey` 우선 |
| 서버 | Node 24 + TypeScript + Express 4 | `ws`, `zod` |
| DB | PostgreSQL 16+ (외부) + Drizzle | 마이그레이션 리포지토리 포함 |
| 세션 | 불투명 토큰 + HttpOnly 쿠키 | JWT 미사용(브라우저 저장소 노출 방지) |
| 테스트 | Vitest(단위·통합), Playwright(E2E) | 암복호화 왕복·평문 부재 검증 |
| 배포 | Docker + 리버스 프록시(TLS) + 외부 DB | 마이그레이션은 배포 job으로 분리 |

## 확정된 결정 / 남은 결정

**확정 (2026-11-14)**

| # | 항목 | 결정 |
|---|---|---|
| D-1 | 다중 기기 지원 | 지원 — 기기별 키 봉투, 내 다른 기기도 수신 대상 |
| D-2 | 계정 식별 | username만 (이메일 미수집, MVP) |
| D-3 | 발신자 서명 | Ed25519 기기 서명 포함 |
| D-4 | 새 기기 로그인 | 새 키 생성 + "이후 메시지만" 안내 (키 백업·이력 이전은 이후) |
| D-5 | 삭제 정책 | 대화=내 화면 숨김, 계정=익명화 후 상대 이력 유지 |
| D-6 | UI 스택 | React 19 + Vite + Tailwind + shadcn/ui |
| D-8 | 브라우저/폴백 | 최신 2개 메이저 + `@noble/curves` 폴백 |

**남은 결정**

| # | 항목 | 권장 | 영향 |
|---|---|---|---|
| D-7 | 다중 인스턴스 | M4에 Redis 팬아웃 | 운영 구조 |
