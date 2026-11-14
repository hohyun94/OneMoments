# OneMoments

개인용 **1:1 종단간 암호화(E2E) 메신저**, 웹 우선. 서버는 평문·대화 키·기기 개인키를 갖지 않고 **암호문 봉투만** 저장·중계한다.

**현재 단계: M1 서버 코어 구현 완료** (웹 클라이언트는 M2)

## 구현된 것

- **계정/세션**: scrypt 비밀번호, HttpOnly 세션 쿠키, 세션 토큰은 SHA-256 해시로만 저장, CSRF(세션 파생 HMAC) + Origin 가드
- **기기**: X25519 신원 키 + Ed25519 서명 키 등록·폐기, 폐기 시 해당 세션 즉시 무효
- **대화**: 1:1 중복 방지, 대화 숨김(내 화면만, 상대 이력 유지)
- **메시지**: AES-256-GCM 암호문 1건 + **기기별 키 봉투**(`message_keys`) N건, Ed25519 서명 보관, `clientMessageId` 멱등, **활성 기기 집합 일치 검증**(불일치 시 409)
- **실시간**: WebSocket 구독·전송·ack·타이핑·presence, 연결된 기기마다 자기 봉투만 전달
- **운영**: `/healthz`, `/readyz`, 마이그레이션, 레이트리밋, 만료 세션 정리
- **테스트 32개**: 단위 + API + WebSocket. 실제 PostgreSQL·실제 소켓으로 암복호화 왕복과 평문 부재를 검증

## 빠른 시작

DB는 외부에서 구성한다. 서버는 `DATABASE_URL` 만 요구한다.

```bash
pnpm install
cp .env.example .env      # DATABASE_URL, SESSION_SECRET 수정
pnpm db:migrate
pnpm dev                  # http://localhost:3900
```

로컬 테스트용 DB가 필요할 때만:

```bash
docker compose -f docker-compose.db.yml up -d
docker exec onemoments-postgres psql -U onemoments -d onemoments -c "CREATE DATABASE onemoments_test"
```

## Coolify 배포 (PostgreSQL 컨테이너)

`docker-compose.coolify.yml` 하나로 **앱 + PostgreSQL 컨테이너**를 올린다. DB는 외부 포트를 열지 않고 내부 네트워크로만 통신하며, TLS·도메인은 Coolify가 처리한다.

1. Coolify → **New Resource → Docker Compose** → 저장소/브랜치 선택, Compose 파일 `docker-compose.coolify.yml`
2. 환경변수 주입

| 변수 | 필수 | 예시 |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | ✅ | `onemoments` / 긴 랜덤 값 / `onemoments` |
| `DATABASE_URL` | ✅ | `postgres://onemoments:<url-encoded-password>@postgres:5432/onemoments` |
| `SESSION_SECRET` | ✅ | `openssl rand -base64 48` (32자 이상) |
| `CORS_ORIGINS` | ✅ | `https://chat.example.com` |
| `DB_POOL_MAX` | — | `5` (인스턴스 수 × 값 ≤ DB max_connections) |

3. `app` 서비스에 도메인을 연결하고 **포트 8080**, HTTPS를 켠다.
4. 배포 → 기동 시 `node scripts/migrate.mjs`가 자동 적용된 뒤 서버가 뜬다.
5. 확인: `https://<도메인>/healthz`, `/readyz`, 로그인 후 쿠키가 `Secure; HttpOnly`인지 확인.

자세한 절차·백업·트러블슈팅: [`docs/05-deploy-coolify.md`](docs/05-deploy-coolify.md)

> Coolify의 **내장 PostgreSQL 리소스**를 쓰려면 compose에서 `postgres` 서비스를 제거하고,
> `DATABASE_URL`을 그 리소스의 내부 주소로 지정하면 된다(백업·모니터링은 Coolify가 관리).

## 검증

```bash
pnpm verify:full   # 타입 체크(테스트 포함) + 테스트 + 빌드
# 외부 DB: TEST_DATABASE_URL=postgres://... pnpm test
```

## 암호화 모델 요약

- 클라이언트: 콘텐츠 키(AES-256-GCM) + 수신 기기별 X25519 ECDH→HKDF 봉투 + Ed25519 서명
- 서버: `ciphertext`, 기기별 `wrapped_key`, 서명만 보관. **복호화 경로 없음**
- 규격·위협 모델·데이터 모델: [`docs/02-architecture.md`](docs/02-architecture.md)

## 문서

- [제품 정의](docs/00-product.md) — 타깃, 핵심 시나리오, MVP 범위, 확정 결정
- [요구사항](docs/01-requirements.md) — 기능/비기능 요구사항과 수용 기준
- [아키텍처·보안 설계](docs/02-architecture.md) — E2E 암호 설계, 데이터 모델, API, 위협 모델
- [화면 와이어프레임](docs/04-wireframes.md) — 로그인·대화 목록·채팅·기기/안전번호
- [로드맵](docs/03-roadmap.md) — 마일스톤과 완료 기준
- [Coolify 배포](docs/05-deploy-coolify.md) — PostgreSQL 컨테이너, 환경변수, 백업, 트러블슈팅

## 원칙

1. 서버는 **평문·대화 키·기기 개인키**를 갖지 않는다.
2. 결정은 문서에 먼저 남긴다.
3. 개인정보는 최소한으로 수집한다(메타데이터 포함).
