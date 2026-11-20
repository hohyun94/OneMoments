# Double Ratchet

메시지 키 봉투를 **체인·DH 래칫**으로 유도해 순방향 비밀성(FS)을 강화한다. 서버는 여전히 헤더와 암호문만 저장하며 키를 모른다.

## 1. 세션

- 범위: **내 기기 × 대화 × 상대 기기**. `sessionKey = localDeviceId:conversationId:remoteDeviceId`
- 저장 키에 **내 기기(localDeviceId)** 를 포함한다. 같은 브라우저에서 계정을 바꿔 로그인해도
  (실제/decoy, 공유 PC) 서로의 세션을 덮어쓰지 않는다.
  v3 이하 키(`conversationId:remoteDeviceId`)는 IndexedDB **v4 업그레이드에서 자동 이전**한다.
- 상태: `rootKey`, `sendChainKey`, `recvChainKey`, `dhSelf`(X25519), `dhRemote`, `sendCount`, `recvCount`, `previousSendCount`, `skipped`
- 저장: IndexedDB `ratchetSessions` (localStorage 아님)
- 송·수신 동시 접근은 탭 내부 mutex + **Web Locks**(탭 사이)로 직렬화한다.

## 2. 초기화와 래칫

1. 세션이 없으면 발신자는 새 X25519 ratchet 키 `A1`을 만들고, 상대의 **정적 IK 공개키 `B0`** 와 DH:
   `RK1, CKs = KDF_RK(0, DH(A1_priv, B0_pub))`
2. 수신자는 자신의 정적 IK private `B0_priv`와 헤더의 `A1_pub`로 같은 `RK1, CKr`을 유도한다.
3. 상대가 답장하면 새 ratchet 키 `B1`으로 DH ratchet:
   `RK2, CKs = KDF_RK(RK1, DH(B1_priv, A1_pub))` → 헤더에 `B1` 포함
4. 수신자는 새 DH 공개키를 보면 이전 수신 체인의 남은 메시지를 **건너뛴 키**로 저장한 뒤
   `RK2, CKr = KDF_RK(RK1, DH(A1_priv, B1_pub))`, 새 `A2`를 만들어 송신 체인도 래칫한다.
5. 메시지 키: `MK = HMAC-SHA256(CK, 0x01)`, 다음 체인: `HMAC-SHA256(CK, 0x02)`

- KDF_RK: `HKDF-SHA256(salt=RK, ikm=DH, info="onemoments/dr/root-v1", 64바이트)`
- 메시지 키로 콘텐츠 키를 AES-256-GCM 래핑한다(파일 첨부도 동일).
- 순서가 뒤바뀐 메시지는 `skipped[ratchetPub:messageNumber]`로 복호화하며 **최대 1000개**까지 저장한다.
- v2 봉투 헤더: `ratchetPublicKey`, `previousChainLength`, `messageNumber`.

## 3. 이력과 백업

DR message key는 1회용이므로 새로고침 후 서버 이력을 다시 읽으려면 키를 보관해야 한다.

- 수신 성공 시 message key를 `historyKeys`(`deviceId:messageId`)에 저장한다.
- 복호화 시 이력 키가 있으면 세션을 전진시키지 않고 그 키로 콘텐츠 키를 푼다.
- 키 백업(`docs/08-key-backup.md`)에 **DR 세션 + 최근 이력 키 5000개**를 포함한다.
- 복구 시 세션·이력 키를 IndexedDB에 복원해 **백업 시점까지**의 DR 이력을 읽는다.
- 백업 이후 받은 메시지는 다시 백업하지 않으면 새 브라우저에서 복호화할 수 없다(스냅샷).

## 4. 적용 범위

- 1:1과 그룹 모두 참여자 기기마다 별도 세션을 쓴다. 그룹은 메시지당 기기 수만큼 v2 봉투가 생긴다.
- **발신자 자신의 기기 봉투는 v1(정적 키)** 이다. 즉시 표시·복구를 단순화하기 위한 선택이며,
  기기 키 침해 시 **내가 보낸 메시지**의 콘텐츠 키는 정적 키로 풀 수 있다.
- 기존 v1 메시지는 계속 v1으로 복호화한다. 서버는 두 버전을 함께 저장한다.

## 5. 보장과 한계

| 항목 | 내용 |
|---|---|
| 서버 DB 유출 | 헤더·암호문만으로 복호화 불가 |
| 수신 v2 이력 | 체인 키 폐기 + DH ratchet으로 FS |
| 상대 정적 키 침해 | **첫 DH ratchet 이전** 메시지는 취약(X3DH 없음) |
| 내 기기 키 침해 | 내가 보낸 v1 봉투는 취약, 로컬 이력 키도 함께 노출될 수 있음 |
| 백업 암호 유출 | 백업에 포함된 세션·이력 키로 백업 시점 이력 복호화 가능 |
| 다중 탭 동시 전송 | **Web Locks API**로 같은 세션(`localDeviceId:conversationId:remoteDeviceId`) 작업을 탭 사이에서도 직렬화한다. Web Locks 미지원·비보안 컨텍스트에서는 탭 내부 락만 적용된다 |
| 세션/이력 저장소 삭제 | 백업 없이는 과거 v2 이력 복호화 불가 |
| 로컬 이력 키 | IndexedDB에 평문(base64)으로 저장 — 기기/XSS 침해 시 노출 |

## 6. 검증

- 클라이언트: 양방향 DH ratchet, 순서 뒤바뀜(3→1→2), 건너뛴 키, 이력 키 재복호화,
  변조 메시지가 세션 상태를 소모하지 않음, WebCrypto/noble 상호운용
- 서버: v1/v2 봉투 저장·검증, 잘못된 v2 헤더 거부
- E2E: DR 메시지 교환·새로고침, 그룹, 첨부, **복구 후 상대의 DR 답장 복호화**
