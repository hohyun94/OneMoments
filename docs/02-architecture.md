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

- 브라우저에서 생성하고, 가능하면 **non-extractable** `CryptoKey`로 IndexedDB에 보관한다.
- WebCrypto의 X25519/Ed25519 지원이 없는 브라우저는 `@noble/curves`로 폴백한다(이 경우 키 보관 방식은 별도 결정).

### 메시지 전송 절차

1. 발신 기기: 32바이트 콘텐츠 키 `K`, 12바이트 `nonce` 생성 → `AES-256-GCM(K, nonce, plaintext)` → `C`(+태그)
2. 발신 기기: `conversationId`, `clientMessageId`, `C`의 해시를 `SK`로 **서명** → `sig`
3. 수신자(상대 사용자 + 내 다른 기기)의 **활성 기기마다**:
   - 임시 X25519 키 쌍 `(e, E)` 생성
   - `shared = ECDH(e_priv, recipient_IK_pub)` → `HKDF-SHA256(shared, info="onemoments/v1/wrap")` → `KEK`
   - `AES-256-GCM(KEK, wrap_nonce, K)` → `W`
4. 서버 전송: `{ clientMessageId, ciphertext: C, nonce, signature: sig, keys: [{ deviceId, ephemeralPublicKey: E, wrapNonce, wrappedKey: W }] }`
5. 발신 기기는 `e_priv`와 `K`를 즉시 폐기한다.

### 수신 절차

1. 수신 기기: 자신의 `deviceId` 봉투를 받는다
2. `shared = ECDH(recipient_IK_priv, E)` → `KEK` → `K` 복원
3. `AES-256-GCM(K, nonce, C)` 복호화
4. 발신 기기의 `SK_pub`으로 `sig` 검증(대화·clientMessageId·암호문 해시)

### 안전번호(safety number)

- 두 사용자의 **활성 기기 공개키(IK+SK)** 를 정렬해 SHA-256 → 숫자/QR로 표시
- 기기 추가·폐기로 지문이 바뀌면 경고한다(TOFU 모델)
- 서버는 안전번호 계산에 관여하지 않는다

### 보장과 한계

| 항목 | MVP 보장 | 비고 |
|---|---|---|
| 기밀성 | 서버·DB·백업에 평문 없음 | 메타데이터는 노출 |
| 무결성 | AES-GCM + Ed25519 서명 | 서버가 변조하면 복호화·검증 실패 |
| 발신자 인증 | 기기 서명 + 안전번호 | 서버가 발신자를 사칭할 수 없음 |
| 순방향 비밀성(FS) | **부분적** | 임시 키는 폐기하지만 Double Ratchet 없음 |
| 기기 키 침해 시 과거 메시지 | 해당 기기 봉투는 복호화 가능 | 봉투 키가 기기 키로 감싸여 있음 |
| 새 기기의 과거 이력 | **불가** | 키 백업/재봉투는 MVP 범위 밖 |

> Double Ratchet(신호 프로토콜 수준의 FS)은 M4 이후 과제로 둔다. MVP는 기기별 정적 키 + 임시 ECDH 봉투로 시작한다.

## 데이터 모델 (초안)

| 테이블 | 주요 컬럼 | 설명 |
|---|---|---|
| `users` | id(uuid), username(unique, 소문자), password_hash, created_at | 계정. 이메일 미수집(MVP) |
| `sessions` | id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent | 쿠키 세션(원문 토큰 저장 안 함) |
| `devices` | id, user_id, name, identity_public_key, signing_public_key, created_at, last_seen_at, revoked_at | 기기 공개키 |
| `conversations` | id, kind('direct'), created_at | 1:1 대화 |
| `conversation_participants` | conversation_id, user_id, joined_at (PK) | 참여자. 1:1은 항상 2명 |
| `messages` | id, conversation_id, sender_user_id, sender_device_id, ciphertext, nonce, signature, client_message_id, created_at | 암호문 1건. `(conversation_id, sender_user_id, client_message_id)` 유니크 |
| `message_keys` | message_id, recipient_device_id, wrapped_key, wrap_nonce, ephemeral_public_key, version (PK: message_id+recipient_device_id) | 기기별 키 봉투 |
| `conversation_reads` | conversation_id, user_id, last_read_message_id, updated_at | 읽음 표시(P1) |

- 인덱스: `messages(conversation_id, created_at desc)`, `message_keys(recipient_device_id)`.
- 대화 이력 조회는 `messages ⋈ message_keys ON recipient_device_id = 내 기기`로 필요한 봉투만 가져온다.
- 서버는 `ciphertext`·`wrapped_key`의 **형식과 크기**만 검증한다.

## API 초안

### 인증·세션

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/auth/register` | `{username, password, device:{name, identityPublicKey, signingPublicKey}}` |
| POST | `/api/auth/login` | `{username, password, deviceId?}`. 새 기기는 `device`를 함께 보내 즉시 등록 |
| POST | `/api/auth/logout` | 현재 세션 종료 |
| GET | `/api/auth/me` | 내 정보 + 세션 기기 |

- 쿠키: `om_session`(HttpOnly, Secure, SameSite=Lax). 원문 토큰은 DB에 저장하지 않고 해시만 저장.
- 상태 변경 요청은 `Origin` 검사 + CSRF 토큰(더블 서브밋)으로 보호한다.

### 기기·사용자·대화

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/devices` | 내 기기 목록(활성/폐기) |
| POST | `/api/devices` | 기기 추가(로그인 상태) |
| DELETE | `/api/devices/:id` | 기기 폐기 → 해당 세션 무효 |
| GET | `/api/users/search?username=` | 정확 일치 검색(스로틀) |
| POST | `/api/conversations` | `{peerUserId}` → 기존 1:1 재사용 |
| GET | `/api/conversations` | 대화 목록(최근 메시지 시각) |
| GET | `/api/conversations/:id/devices` | 양쪽 **활성 기기 공개키**(암호화 대상 목록) |
| DELETE | `/api/conversations/:id` | 내 화면에서 숨김 |

### 메시지

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/conversations/:id/messages?before=&limit=` | 최신순, 내 기기 봉투만 포함 |
| POST | `/api/conversations/:id/messages` | 아래 본문. `clientMessageId` 멱등 |

```jsonc
{
  "clientMessageId": "c-01J...",
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
| S→C | `{type:"message.created", message:{..., key: 내 기기 봉투}}` |
| S→C | `{type:"message.ack", clientMessageId, message}` |
| S→C | `{type:"typing"|"presence"}`, `{type:"error", code, message}` |

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
| 스팸·검색 남용 | 서비스 품질 저하 | 검색/메시지 레이트리밋, 차단(P1) |
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

**남은 결정**

| # | 항목 | 권장 | 영향 |
|---|---|---|---|
| D-4 | 새 기기 로그인 UX | 로그인 시 키 생성, 과거 이력 없음 안내 | 사용자 기대 관리 |
| D-5 | 메시지 삭제 정책 | 내 화면 숨김 + 계정 삭제 시 서버 삭제 | 상대 화면 처리 |
| D-6 | UI 스택 | Tailwind + shadcn/ui | M2 일정 |
| D-7 | 다중 인스턴스 | M4에 Redis 팬아웃 | 운영 구조 |
| D-8 | 최소 브라우저/폴백 | 최신 2개 버전 + `@noble/curves` | 테스트 매트릭스 |
