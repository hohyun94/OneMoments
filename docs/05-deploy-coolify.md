# Coolify 배포 — PostgreSQL 컨테이너

대상: Coolify가 설치된 셀프호스팅 서버, Docker Compose 리소스.
구성: `app`(Node 서버) + `postgres`(PostgreSQL 16) + 영속 볼륨. DB는 외부에 노출하지 않는다.

```
인터넷 ──HTTPS──► [Coolify/Traefik] ──► [app:8080] ──내부망──► [postgres:5432]
                                                              └─ volume: postgres-data
```

## 1. 사전 준비

- Coolify 서버와 배포할 도메인(예: `chat.example.com`)의 DNS A/AAAA 레코드
- 이 저장소를 Coolify가 접근할 수 있는 Git 원격에 푸시
- 시크릿 생성: `openssl rand -base64 48` (SESSION_SECRET, POSTGRES_PASSWORD)

## 2. 리소스 생성

1. Coolify → **New Resource → Docker Compose**
2. 저장소·브랜치 선택, Compose 파일 경로: `docker-compose.coolify.yml`
3. **Environment Variables** 에 아래 값을 추가

| 변수 | 필수 | 설명 |
|---|---|---|
| `POSTGRES_USER` | ✅ | DB 계정 (예: `onemoments`) |
| `POSTGRES_PASSWORD` | ✅ | 긴 랜덤 값 |
| `POSTGRES_DB` | ✅ | DB 이름 (예: `onemoments`) |
| `DATABASE_URL` | ✅ | `postgres://<user>:<url-encoded-password>@postgres:5432/<db>` |
| `SESSION_SECRET` | ✅ | 32자 이상 랜덤 |
| `CORS_ORIGINS` | ✅ | 공개 URL (예: `https://chat.example.com`) |
| `DB_POOL_MAX` | — | 기본 5 |
| `MAX_CIPHERTEXT_BYTES` | — | 기본 16384 |
| `METRICS_TOKEN` | — | `/metrics` Bearer 토큰(16자 이상, 운영 권장) |
| `REDIS_URL` | — | 기본 `redis://redis:6379` (compose에 Redis 포함) |
| `MIGRATE_ON_START` | — | 기본 `true`. 다중 인스턴스에서는 `false` |

> `DATABASE_URL`의 비밀번호는 **URL 인코딩**한다(`@`→`%40`, `:`→`%3A`, `/`→`%2F`).
> compose는 `COOKIE_SECURE=true`, `TRUST_PROXY=1`을 고정으로 넣는다(HTTPS 전제).

4. `app` 서비스의 **Domains** 에 도메인을 연결하고 포트 **8080** 을 지정, HTTPS 활성화
5. Deploy
6. 이미지에는 웹 클라이언트(`client/dist`)도 포함되어 **같은 도메인에서 UI가 서빙**된다. 별도 프론트 서비스는 필요 없다.

## 3. 배포 후 확인

```bash
curl -fsS https://chat.example.com/healthz   # {"status":"ok",...}
curl -fsS https://chat.example.com/readyz    # DB 연결 확인
```

- 로그인 응답의 `Set-Cookie` 에 `HttpOnly; Secure; SameSite=Lax` 가 있는지 확인
- `docker compose logs app` 에서 `server_started` 확인
- `postgres` 컨테이너는 호스트 포트를 열지 않았는지 확인(`docker ps`)

## 4. 백업·복구

**권장**: Coolify의 PostgreSQL 리소스 예약 백업을 쓰거나, 아래를 Coolify **Scheduled Task** 로 등록한다.

```bash
docker exec onemoments-postgres-1 pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Fc > /backups/onemoments-$(date +%F).dump
```

또는 `docker-compose.coolify.yml` 의 `backup` 서비스 주석을 해제해 매일 백업 + 보관 정책을 적용한다.

복구:

```bash
docker exec -i <postgres-container> pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < backup.dump
```

> DB에는 암호문만 있지만 **메타데이터(누가·언제·크기)** 는 민감하다. 백업 파일은 오프사이트에 암호화 보관한다.

## 5. 업데이트·롤백

- 새 커밋을 푸시한 뒤 Coolify에서 Redeploy
- 마이그레이션은 기본적으로 기동 시 자동 적용된다(`scripts/start.mjs`).
- **인스턴스를 2개 이상**으로 늘리면 `MIGRATE_ON_START=false`로 두고, 배포 파이프라인에서 한 번만 실행한다:
  ```bash
  docker compose run --rm app node scripts/migrate.mjs
  ```
- 메시지 팬아웃은 compose의 `redis` 서비스로 동작한다. Dragonfly로 바꾸려면 image만 교체(Redis 호환).
  presence/typing까지 인스턴스 간 공유하려면 sticky session을 함께 사용한다(`docs/06-operations.md`).
- 모니터링: `/metrics`(Prometheus) + `/healthz`·`/readyz`, `METRICS_TOKEN` 설정 권장.
- 백업/복구: [`docs/07-backup-restore.md`](07-backup-restore.md)
- 롤백: 이전 이미지/커밋으로 Redeploy. DB 마이그레이션은 되돌리지 않으므로,
  파괴적 변경은 별도 마이그레이션으로 단계적으로 배포한다.

## 6. 트러블슈팅

| 증상 | 확인 |
|---|---|
| `readyz` 503 / DB 연결 실패 | `DATABASE_URL`의 호스트가 `postgres` 인지, 비밀번호 URL 인코딩 여부, `pg_isready` 로그 |
| 로그인 후 쿠키가 안 붙음 | HTTPS 여부, `COOKIE_SECURE=true`, 프록시에서 `X-Forwarded-Proto` 전달 |
| CSRF 403 | 클라이언트가 `x-csrf-token` 을 보내는지, Origin이 `CORS_ORIGINS`와 일치하는지 |
| 마이그레이션 잠금/중복 실행 | 인스턴스 수 확인, 기동 마이그레이션을 일회성 job으로 분리 |
| WS 연결 실패 | 프록시가 WebSocket 업그레이드(`/ws`)를 허용하는지 |

## 7. 보안 체크리스트

- [ ] `postgres` 포트를 외부에 publish 하지 않는다
- [ ] `SESSION_SECRET`·DB 비밀번호는 Coolify secret 으로만 주입
- [ ] HTTPS 강제, HSTS는 프록시에서 설정
- [ ] `CORS_ORIGINS` 는 실제 프론트 도메인만
- [ ] 백업 보관/복구 리허설 1회
- [ ] 앱 계정은 슈퍼유저가 아닌 전용 role
