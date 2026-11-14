# 운영 가이드 — 다중 인스턴스·모니터링·부하

## 1. 다중 인스턴스 (Redis / Dragonfly 팬아웃)

WebSocket 연결은 인스턴스 메모리에 있으므로, 메시지 이벤트를 인스턴스 간에 전달해야 한다.

```
[인스턴스 A] ──publish/subscribe── [Redis 또는 Dragonfly] ── [인스턴스 B]
      │                                                        │
      └── 로컬 연결 전달                          로컬 연결 전달 ──┘
```

- `REDIS_URL`(예: `redis://redis:6379`)을 설정하면 `RedisMessageBus`가 활성화된다.
- 같은 인스턴스의 연결에는 즉시 전달하고, 다른 인스턴스에는 pub/sub으로 전파한다.
- Redis 장애 시에도 **단일 인스턴스 동작은 유지**된다(로컬 전달). 다만 인스턴스 간 전달은 중단된다.
- `REDIS_CHANNEL` 기본값 `onemoments:events`.
- Dragonfly를 쓰려면 compose의 `redis` 이미지를 `docker.dragonflydb.io/dragonflydb/dragonfly`로 바꾸고 URL은 그대로 사용한다(Redis 호환).

**한계**
- `typing`·`presence`는 구독 중인 **로컬 연결**에만 전달된다.
  여러 인스턴스에서 완전한 presence가 필요하면 sticky session을 켜거나 Redis 기반 presence를 추가해야 한다.
- 메시지(`message.created`)는 참여자 전체에게 전달되므로 인스턴스 간에도 대화 목록이 갱신된다.

## 2. 마이그레이션 (일회성 job)

| 상황 | 설정 |
|---|---|
| 단일 인스턴스 | `MIGRATE_ON_START=true`(기본) — 기동 시 `scripts/migrate.mjs` 실행 |
| 다중 인스턴스 | `MIGRATE_ON_START=false` — 배포 파이프라인에서 **한 번만** 실행 |

```bash
# Coolify/compose 일회성 실행 예시
docker compose -f docker-compose.coolify.yml run --rm app node scripts/migrate.mjs
```

`scripts/start.mjs`가 `MIGRATE_ON_START`를 해석한 뒤 서버를 시작한다.

## 3. 모니터링

### 엔드포인트

| 경로 | 용도 |
|---|---|
| `/healthz` | 프로세스 생존(로드밸런서/컨테이너 healthcheck) |
| `/readyz` | DB 연결 확인(트래픽 수용 가능 여부) |
| `/metrics` | Prometheus 텍스트 메트릭 |

`METRICS_TOKEN`(16자 이상)을 설정하면 `/metrics`는 `Authorization: Bearer <token>`을 요구한다. 운영에서는 반드시 설정한다.

### 메트릭

| 이름 | 설명 |
|---|---|
| `onemoments_up` | 프로세스 생존(항상 1) |
| `onemoments_uptime_seconds` | 기동 후 경과 초 |
| `onemoments_messages_total` | 저장된 메시지 수(프로세스 누적) |
| `onemoments_ws_connections` | 현재 WebSocket 연결 수 |
| `onemoments_db_ready` | DB 도달 가능 여부 |

Prometheus scrape 예시:

```yaml
scrape_configs:
  - job_name: onemoments
    metrics_path: /metrics
    authorization:
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets: ["onemoments:8080"]
```

**권장 알림**
- `up == 0` (5분)
- `onemoments_db_ready == 0` (2분)
- `onemoments_ws_connections`가 비정상적으로 0에 고정되거나 급감
- DB 연결 수/디스크 사용량(PostgreSQL·호스트 모니터링)

## 4. 부하 테스트

```bash
# 서버 기동(레이트리밋을 넉넉히)
MESSAGE_RATE_LIMIT_MAX=10000 pnpm dev

# Node 동시성(권장)
BASE_URL=http://127.0.0.1:3911 MESSAGE_COUNT=200 CONCURRENCY=20 pnpm db:load-test

# k6가 있으면 HTTP 동시성
BASE_URL=http://127.0.0.1:3911 VUS=20 k6 run scripts/load-test.k6.js

# 클라이언트 암복호화 프로파일링
pnpm bench:crypto
```

측정 항목: REST 저장 지연(p50/p95), WebSocket 전달 지연, 초당 처리량, 클라이언트 암복호화 p50/p95.
로컬 예시(200건, 동시성 20): **약 302.6 msg/s, REST p95 103.5ms, 오류 0**.
상세·한계·확장 병목: [`docs/13-performance.md`](13-performance.md)

> Node 부하 테스트는 서버 경로(검증·DB·WS)만 측정하고 실제 암호화 비용은 포함하지 않는다.
> 클라이언트 비용은 `pnpm bench:crypto`로 별도 확인한다.

## 5. 컨테이너 이미지

- 멀티스테이지: 빌드 단계에서 서버·클라이언트를 빌드하고 `pnpm deploy`로 **서버 런타임 의존성만** 추출한다.
- 런타임 이미지에는 pnpm/빌드 도구가 포함되지 않는다.
- `scripts/start.mjs`가 마이그레이션(옵션) 후 서버를 시작한다.

## 6. 백업/복구

[`docs/07-backup-restore.md`](07-backup-restore.md) 참고.

## 7. 첨부 저장소

- `ATTACHMENT_STORAGE=local|s3`, `ATTACHMENT_TTL_DAYS`(기본 30)로 저장소와 고아 TTL을 설정한다.
- 로컬 모드는 `ATTACHMENT_DIR`(compose `attachments` 볼륨)에 저장하며 컨테이너 `node` 사용자 쓰기 권한이 필요하다.
- S3는 `S3_BUCKET`/`S3_REGION`/`S3_ENDPOINT`/`S3_FORCE_PATH_STYLE`, IAM 역할 또는 access/secret 키를 사용한다.
- 고아 정리: `pnpm attachments:cleanup` (메시지에 연결되지 않은 업로드만, 하루 1회 권장).
- **DB와 첨부 저장소를 함께 백업**한다. 상세: `docs/10-attachments.md`.

## 8. 푸시 알림

- `pnpm push:keys`로 VAPID 키를 한 번 생성해 환경변수로 주입한다. 키를 바꾸면 사용자가 알림을 다시 켜야 할 수 있다.
- HTTPS가 필수다(서비스 워커·Push API). iOS는 홈 화면에 추가한 PWA에서만 동작한다.
- VAPID 미설정 시 푸시만 비활성화되고 메시지·첨부 기능은 정상 동작한다.
- 발송 실패는 메시지 전달을 막지 않는다. 404/410 구독은 자동 삭제, 그 외 실패는 `failure_count`로 추적한다.
- subscription endpoint는 민감 정보이므로 로그에 원문을 남기지 않는다.
- 상세: [`docs/12-push-mobile.md`](12-push-mobile.md)

