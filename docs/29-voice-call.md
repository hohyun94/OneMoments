# 1:1 음성 통화 (WebRTC)

메신저 안에서 **1:1 음성 통화**를 제공한다. v1 범위는 **오디오만, 1:1만**이며
그룹 통화·영상은 후속 단계로 둔다(`docs/00-product.md` 의 범위 외 항목 중 하나를 좁혀 구현).

## 1. 설계 요약

| 요소 | 선택 | 이유 |
|---|---|---|
| 미디어 | **WebRTC P2P(브라우저 간 직접)** | 서버가 음성을 저장·복호화하지 않아 E2E 원칙과 충돌하지 않는다 |
| 시그널링 | 기존 **인증된 WebSocket**(`/ws`) | 세션·기기 인증, 다중 인스턴스 팬아웃(Redis) 재사용 |
| NAT 통과 | STUN + **TURN 폴백**(coturn) | P2P 실패율 10~20% 대비. 서버는 암호문만 중계 |
| 서버 저장 | **없음**(통화 기록·녹음 없음) | 메타데이터 최소화. 시그널링은 1회 중계 후 폐기 |
| 암호화 | DTLS-SRTP(기본) | 피어 간 E2E. TURN 은 암호문만 전달하므로 내용을 볼 수 없다 |

> 통화는 **메시지 이력·검색·암호문 저장 대상이 아니다.** 서버는 “누가 언제 통화를 시도했는지”조차
> 저장하지 않는다(필요해지면 별도 메타데이터 설계 + 보존 정책을 먼저 정한다).

## 2. 자원 사용량 (근거)

| 구간 | 자원 | 수치 |
|---|---|---|
| 시그널링 | 서버 CPU/대역 | 통화당 SDP 4~8KB + ICE candidate 수십 개 → **<100KB**, CPU 무시 가능 |
| 미디어(P2P) | 서버 | **0** (피어 간 직접) |
| 미디어(TURN 경유) | 서버 **대역폭** | 방향당 32kbps(Opus) × 2 = 64kbps ≈ **28.8MB/시간/통화**, CPU 낮음 |
| 클라이언트 | CPU/배터리 | 1코어의 2~10%, 배터리 시간당 3~8%(기기별) |

- 하루 20통 × 10분, 절반이 TURN 경유여도 **≈ 48MB/일(월 1.5GB)** 수준이다.
- **영상**은 720p 기준 20~40% CPU 로 급증하고, **그룹 통화**는 SFU(서버 미디어 종단)가 필요해
  E2E 설계(SFrame)와 함께 별도 단계로 다룬다.

## 3. 흐름

```
[A] 발신자                         서버(WS)                       [B] 수신자
 call.invite ───────────────▶ 참여자·1:1 검증 → 중계 ──────────▶ call.invite (벨)
 getUserMedia                                              ⋯ 벨 UI
                            ◀──────────── call.accept ────────────  getUserMedia
 createOffer / setLocalDescription
 call.signal(offer) ─────────▶ 중계 ──────────────────────────▶ setRemoteDescription
                     ◀────────── call.signal(answer) ───────────  createAnswer
 ICE candidate 양방향 중계(call.signal)
 === DTLS-SRTP 오디오 P2P (TURN 불가 시 릴레이) ===
 call.end ──────────────────▶ 중계 ──────────────────────────▶ call.ended
```

- 서버는 SDP/ICE 를 **해석하지 않고 그대로 전달**한다. 발신 기기(`fromDeviceId`)로는 되돌리지 않는다.
## 4. 프로토콜

### 클라이언트 → 서버

| 타입 | 필드 | 검증 |
|---|---|---|
| `call.invite` | `conversationId`, `callId`(uuid), `media:"audio"` | 참여자 + **direct 대화**만 |
| `call.accept` | `conversationId`, `callId`, `media` | 동일 |
| `call.decline` | `conversationId`, `callId`, `reason?`(`declined`\|`busy`\|`unsupported`) | 동일 |
| `call.cancel` | `conversationId`, `callId` | 동일 |
| `call.end` | `conversationId`, `callId`, `reason?`(`hangup`\|`failed`\|`timeout`) | 동일 |
| `call.signal` | `conversationId`, `callId`, `signal{ description?, candidate? }` | SDP ≤ 64KB, candidate ≤ 2KB |

### 서버 → 클라이언트(중계)

`call.invite`(·`createdAt`) / `call.accepted` / `call.declined` / `call.cancelled` / `call.ended` / `call.signal`
— 모두 `conversationId`, `callId`, `fromUserId`, `fromDeviceId` 를 포함한다.

### 오류 코드

| 코드 | 의미 |
|---|---|
| `CALL_REQUIRES_DIRECT` | 그룹 대화(참여자 2명 그룹 포함) — v1 범위 밖 |
| `CONVERSATION_NOT_FOUND` | 비참여자(대화 존재 여부도 숨김) |
| `INVALID_FRAME` | SDP/ICE 형식 오류 |
| `RATE_LIMITED` | 프레임 폭주(10초당 120개) |

## 5. ICE/TURN 설정

`GET /api/call/config`(세션 필요, `Cache-Control: private, no-store`) 응답:

```json
{
  "enabled": true,
  "iceServers": [
    { "urls": ["stun:turn.example.com:3478"] },
    { "urls": ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349"],
      "username": "1794672294:<userId>", "credential": "<base64 HMAC-SHA1>" }
  ],
  "ringTimeoutSeconds": 30,
  "media": "audio"
}
```

| 환경변수 | 의미 |
|---|---|
| `CALL_ENABLED` | 전체 on/off(기본 true) |
| `CALL_STUN_URLS` | 쉼표 구분 `stun:` URL |
| `CALL_TURN_URLS` | 쉼표 구분 `turn:`/`turns:` URL |
| `CALL_TURN_SECRET` | coturn `static-auth-secret` (URLS 를 넣으면 **필수**) |
| `CALL_TURN_TTL_SECONDS` | 자격증명 만료(기본 600초) |
| `CALL_RING_TIMEOUT_SECONDS` | 벨 타임아웃(기본 30초) |

- TURN 자격증명은 **coturn REST 규약**: `username = "<만료 unix>:<userId>"`,
  `credential = base64(HMAC-SHA1(secret, username))`. 사용자·시간에 묶여 재사용 기간이 짧다.
- 잘못된 스킴(예: `CALL_STUN_URLS=turn:...`)은 **기동 실패**로 알린다.

### coturn 예시

```yaml
  turn:
    image: coturn/coturn:4.6
    restart: unless-stopped
    network_mode: host          # UDP 릴레이 포트를 그대로 쓴다
    command:
      - --listening-port=3478
      - --tls-listening-port=5349
      - --static-auth-secret=${CALL_TURN_SECRET}
      - --realm=onemoments
      - --use-auth-secret
      - --fingerprint
      - --no-multicast-peers
      - --min-port=49160
      - --max-port=49200
      - --cert=/etc/letsencrypt/live/example.com/fullchain.pem
      - --pkey=/etc/letsencrypt/live/example.com/privkey.pem
```

- 방화벽: `3478/udp`, `5349/tcp(및 udp)`, 릴레이 범위 `49160-49200/udp` 개방.
- 제한망(사내·모바일)은 UDP 가 막히므로 **`turns:`(TLS 443)** 를 함께 제공하는 것을 권장한다.

## 6. 보안·프라이버시

- **내용 비저장**: 서버는 오디오를 받지 않는다. TURN 경유 시에도 DTLS-SRTP 암호문만 중계한다.
- **IP 노출**: P2P 성공 시 상대에게 내 공인 IP 가 보인다. 필요하면 “항상 릴레이” 옵션(추후)으로 회피한다.
- 시그널링은 기존 세션 쿠키 + Origin 검증이 적용된 `/ws` 로만 오간다.
- 마이크 권한은 `getUserMedia({audio:true})` 로만 요청하며, 통화 종료 시 **모든 트랙 stop**.
- 자동 재생 정책: 수신 통화는 사용자 제스처(수락 버튼) 후에만 오디오를 재생한다.

## 7. 클라이언트 UX (v1)

| 위치 | 동작 |
|---|---|
| 대화 헤더(1:1) | **통화 버튼** — `CALL_ENABLED=false` 면 숨김 |
| 발신 중 | “연결 중…” 바 + 취소. 30초 타임아웃 |
| 수신 | 모달: 발신자 이름, **수락 / 거절**. 거절 시 상대에게 `declined` |
| 통화 중 | 상단 바: 통화 시간, **음소거**, **종료**. 상대가 끊으면 자동 종료 + 안내 |
| 오류 | 마이크 권한 거부, 수락 없음(타임아웃), 연결 실패(`failed`) 안내 |

- 다중 기기: 벨은 **모든 기기**에 울리고, 먼저 수락한 기기와 연결한다. 나머지 기기는 `call.accepted` 수신 시 벨을 닫는다.
- 통화 상태는 **메모리에서만** 관리한다(새로고침 시 통화 종료).
- v1 한계: 실시간 연결은 **채팅 화면(대화 목록·대화방)** 에서만 살아 있다. 기기 관리·Moments·연락처 화면에서는
  벨이 울리지 않는다(전역 실시간 연결은 후속).

## 8. 상태 머신

```
idle ──invite(발신)──▶ outgoing ──accepted──▶ connecting ──connected──▶ active
  │                        │                     │                        │
  │                        ├─ declined/cancel ───┴─ failed ───────────────┤
  │                        ▼                                              ▼
  └──invite(수신)──▶ ringing ──decline/ timeout ──▶ ended ◀──────── end ──┘
```

- `active` 는 `RTCPeerConnection.connectionState === "connected"` 를 뜻한다.
- `ended` 는 3초 후 `idle` 로 돌아가고 UI 만 정리한다(서버 상태 없음).

## 9. 검증

| 계층 | 내용 |
|---|---|
| 서버(WS) | 1:1 초대 중계, 발신 기기 미반향, signal/accepted/ended 중계, 그룹 거부(`CALL_REQUIRES_DIRECT`), 비참여자 404 |
| 서버(REST) | `/api/call/config` 인증, ICE 목록, TURN 자격증명 HMAC, 스킴 검증·시크릿 필수 |
| 클라이언트 | 상태 머신, ICE 설정 정규화, 발신/수락/종료 핸들러 |
| E2E | 가짜 마이크(`--use-fake-device-for-media-stream`) 2브라우저: 발신 → 수락 → `connectionState=connected` → 음소거 → 종료 |

## 10. 한계·후속

- 그룹 통화: SFU(mediasoup/LiveKit) 필요. E2E 를 유지하려면 insertable streams(SFrame) 설계가 선행되어야 한다.
- 영상: 대역폭·CPU 가 10배 이상. 오디오 안정화 후 별도 단계.
- 통화 기록/부재중 알림: 저장 정책(암호화·보존·삭제)을 먼저 정한 뒤 추가한다.
- 다중 기기 동시 수락 경합, ICE restart 기반 재연결은 v1.1 에서 다듬는다.

