# Sender Keys (그룹)

그룹 메시지는 **발신자별 sender key 체인**으로 1회 암호화하고, 새 기기에만 체인 상태를 pairwise 봉투로 배포한다. 1:1은 기존 Double Ratchet(v2)을 유지한다.

## 1. 왜

기존 그룹은 메시지마다 참여자 기기 수만큼 v2 봉투를 만들었다.
Sender Keys를 쓰면 **에포크 최초 배포 때만 기기별 봉투**가 필요하고, 이후 메시지는 봉투 없이 전송된다.

## 2. 흐름

1. 발신 기기는 대화별 sender key 세션(`senderKeyId`, 32바이트 체인 키, iteration)을 만든다.
2. 아직 배포하지 않은 기기에는 **현재 체인 상태(chainKey, iteration)** 를 JSON으로 만들고
   - 임의의 배포 콘텐츠 키로 AES-GCM 암호화하고
   - 그 콘텐츠 키를 기존 **DR v2 봉투**로 각 기기에 감싼다.
   - 봉투에 `distributionCiphertext`/`distributionNonce`를 함께 저장한다.
3. 메시지 본문은 sender key 체인의 message key로 1회 AES-GCM 암호화하고 Ed25519로 서명한다.
4. 서버에는 `messages.sender_key_id`, `sender_key_iteration`과 (있다면) 배포 봉투만 저장한다.
5. 수신 기기는 배포 봉투가 있으면 체인을 초기화하고, 없으면 저장된 sender key 세션으로 메시지를 복호화한다.
6. 순서가 뒤바뀐 메시지는 체인을 전진시키며 **건너뛴 키(최대 1000개)** 를 저장해 처리한다.
7. 참여자 수가 바뀌면(추가/나가기) 다음 전송 시 **새 senderKeyId로 회전**하고 새 체인을 배포한다.

## 3. 서버 모델

| 컬럼 | 의미 |
|---|---|
| `messages.sender_key_id` | 발신자 체인 ID(UUID). pairwise 메시지는 null |
| `messages.sender_key_iteration` | 체인 반복 번호 |
| `message_keys.distribution_ciphertext` / `distribution_nonce` | 배포 체인 상태 암호문 |
| `message_keys` 행 | 배포가 필요한 기기에만 존재(이후 메시지는 0개 가능) |

- sender-key 메시지는 기기 집합 전체 일치를 요구하지 않는다. 배포 대상은 활성 참여자 기기여야 한다.
- 이력 조회는 (1) 내 기기 봉투가 있는 메시지 또는 (2) 참여 이후 sender-key 메시지만 반환한다.
  새 참여자는 참여 이전 sender-key 메시지를 볼 수 없다.
- 발신 기기의 WS `message.created`는 봉투가 없으므로 생략하고 REST 응답으로 표시한다.

## 4. 백업·이력

- sender key 세션을 IndexedDB에 저장하고 키 백업에 포함한다.
- 각 sender-key 메시지의 message key를 `historyKeys`에 저장해 새로고침/복구 후 재복호화한다.
- 백업은 스냅샷이므로 이후 메시지는 다시 백업해야 한다.
- 참여자 수 변경으로 회전한 이전 체인도 백업에 남는다.

## 5. 보안·한계

| 항목 | 내용 |
|---|---|
| 배포 기밀성 | 체인 상태는 DR v2 봉투로만 전달 |
| 메시지 인증 | 기존 Ed25519 발신 기기 서명 유지 |
| 순방향 비밀성 | **에포크 내에서는 제한적** — sender key 체인은 대칭이고 DH 래칫이 아님 |
| 멤버 침해 | 그 침해 시점의 sender key로 같은 에포크의 과거/미래 메시지 복호화 가능 |
| 회전 | 참여자 수 변경 시 다음 전송에서 회전(수동 키 회전 UI는 없음) |
| 로컬 상태 | sender key/이력 키는 IndexedDB·백업에 존재(XSS/기기 침해 시 노출) |
| 다중 탭 | 탭 간 sender key 카운터 락 없음(단일 탭 전제) |
| 새 기기 | 배포가 포함된 첫 메시지 이후부터 복호화 가능 |
| 1:1 | 기존 Double Ratchet 유지 |

> Sender Keys는 그룹 팬아웃 비용을 줄이는 최적화이며, 그룹 전체에 Double Ratchet 수준의 FS를 제공하지는 않는다.
> 그룹 멤버 변경 시 회전으로 노출 구간을 제한한다.

## 6. 검증

- 클라이언트: 최초 배포 2개 봉투 → 이후 0개, 순서 뒤바뀜, 이력 키 재복호화, 새 기기 배포, 발신자 본인 이력
- 서버: 봉투 0개 sender-key 저장, 부분 배포 봉투, 배포 필드 검증, pairwise에 배포 필드 금지, 참여 이후 이력 필터
- E2E: 3인 그룹 생성 → 메시지/답장 → 참여자 추가(회전·신규 배포) → 나가기
