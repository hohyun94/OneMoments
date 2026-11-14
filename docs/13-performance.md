# 성능·부하 테스트

## 1. 서버 동시성 (Node)

```bash
# 서버(레이트리밋 완화)
PORT=3911 MESSAGE_RATE_LIMIT_MAX=10000 pnpm dev

# 다른 터미널
BASE_URL=http://127.0.0.1:3911 MESSAGE_COUNT=200 CONCURRENCY=20 pnpm db:load-test
```

- 두 계정이 한 대화에서 번갈아 전송하고, 수신자 WebSocket으로 전달 지연을 잰다.
- `CONCURRENCY` 개 워커가 메시지 큐를 나눠 처리한다.
- 봉투는 서버 형식만 맞춘 가짜 값이다. **서버 경로(검증·DB·WS 팬아웃) 부하**를 측정하며 실제 암호화 비용은 포함하지 않는다.

로컬 개발 머신 결과(200건, 동시성 20, 단일 인스턴스·Redis 없음):

| 항목 | 결과 |
|---|---|
| 처리량 | **302.6 msg/s** |
| 오류 | 0 |
| REST 지연 p50 / p95 | 62.4ms / **103.5ms** |
| WS 전달(전송 시작 기준) p50 / p95 | 62.4ms / 103.5ms |

> WS 전달이 REST 응답보다 먼저 도착하면 두 값이 같게 보인다. 실제로는 전송 시작→WS 프레임 수신 시간이다.

## 2. k6 (HTTP 동시성)

k6가 설치되어 있으면(또는 Docker 이미지) 동일한 서버 경로를 부하 테스트할 수 있다.

```bash
BASE_URL=http://127.0.0.1:3911 VUS=20 DURATION=30s k6 run scripts/load-test.k6.js
```

- `setup()`에서 계정 2개·대화·기기 목록을 만들고, VU들이 번갈아 메시지를 전송한다.
- 임계값: `http_req_failed < 1%`, `http_req_duration p95 < 500ms`.
- 실제 암호화는 하지 않는다(서버 검증용 봉투). WebSocket 지연은 Node 스크립트로 측정한다.
- 공유 계정을 쓰므로 서버 `MESSAGE_RATE_LIMIT_MAX`를 충분히 높여야 한다.
- 이 저장소 환경에는 k6가 설치되어 있지 않아 **스크립트 문법(`node --check`)만 검증**했다.

## 3. 클라이언트 암복호화

```bash
pnpm bench:crypto
```

- 브라우저와 같은 클라이언트 코드(WebCrypto + DR + 첨부)를 Node에서 실행해 p50/p95를 잰다.
- `BENCH_ITERATIONS`(기본 50), `BENCH_BACKUP_ITERATIONS`(기본 3)로 조정.
- warmup 5회 후 측정한다.

로컬 결과(WebCrypto backend, 50회):

| 작업 | mean | p50 | p95 |
|---|---|---|---|
| DR 메시지 암호화+복호화 | 0.93ms | 0.88ms | **1.21ms** |
| 1MiB 첨부 암호화 | 1.55ms | 1.35ms | **2.53ms** |
| 1MiB 첨부 복호화 | 1.17ms | 1.01ms | **2.11ms** |
| 안전번호(4명) | 0.19ms | 0.13ms | 0.51ms |
| 키 백업 내보내기+가져오기(PBKDF2 600k) | 171ms | 170ms | 174ms |

> Node WebCrypto 결과이며 모바일 브라우저와 다르다. 실제 iOS/Android는 HTTPS·PWA 또는 네이티브 앱에서 별도 측정이 필요하다.

## 4. 확장 시 병목

| 지점 | 영향 | 대응 |
|---|---|---|
| DB 커넥션 풀 | 동시 저장 지연 | `DB_POOL_MAX` 조정, DB 모니터링 |
| 기기별 봉투 수 | 그룹·다기기에서 쓰기 증가 | 그룹 20명 제한, Sender Keys 후속 |
| WebSocket 팬아웃 | 단일 인스턴스 연결 수 | Redis/Dragonfly 팬아웃 + sticky session |
| 첨부 업로드 | 디스크/대역폭 | 8MB 제한, 레이트리밋, 오브젝트 스토리지 후속 |
| 푸시 팬아웃 | 메시지당 구독 수만큼 외부 요청 | 비동기·실패 격리, TTL, 허용 호스트 제한 |
| PBKDF2 600k | 백업/복구 지연 | UI에서 진행 표시, 필요 시 Argon2id 검토 |

## 5. 재현 체크리스트

- [ ] 서버 레이트리밋 완화(`MESSAGE_RATE_LIMIT_MAX`)
- [ ] `CONCURRENCY`/`MESSAGE_COUNT` 기록
- [ ] DB·Redis·호스트 스펙 기록
- [ ] 오류 수 0 확인
- [ ] p95가 목표(예: <200ms) 내인지 확인
- [ ] 암호화 비용은 `bench:crypto`로 별도 기록
