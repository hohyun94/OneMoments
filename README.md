# OneMoments

개인용 **1:1 종단간 암호화(E2E) 메신저**, 웹 우선. 서버는 평문·대화 키·기기 개인키를 갖지 않고 **암호문 봉투만** 저장·중계한다.

**현재 단계: M2 웹 클라이언트 완료 (브라우저 E2E 포함)**

## 구현된 것

- **웹 클라이언트** (`client/`): React 19 + Vite + Tailwind, 로그인/가입, 대화 목록, 채팅, 기기 관리
- **E2E 암호화**: 브라우저에서 X25519/Ed25519 키 생성·보관(IndexedDB), 기기별 키 봉투, Ed25519 서명 검증
- **계정/세션**: scrypt 비밀번호, HttpOnly 세션 쿠키, CSRF(세션 파생 HMAC) + Origin 가드
- **기기**: 키 등록·폐기, 폐기 시 세션 무효, 새 기기는 이후 메시지만 수신
- **대화**: 1:1 중복 방지, 숨김(내 화면만), 실시간 수신·타이핑·presence, 재연결
- **메시지**: AES-256-GCM 암호문 + 기기별 키 봉투, 서명, 멱등 전송, 기기 집합 검증(409), 복호화 실패 표시
- **운영**: `/healthz`, `/readyz`, 마이그레이션, 레이트리밋, 프로덕션에서 클라이언트 정적 서빙
- **테스트 38개**: 서버 33(단위·API·WS) + 클라이언트 암호화 4 + 브라우저 E2E 1

## 빠른 시작

DB는 외부에서 구성한다. 서버는 `DATABASE_URL` 만 요구한다.

```bash
pnpm install
cp .env.example .env      # DATABASE_URL, SESSION_SECRET 수정
pnpm db:migrate

# 터미널 1 — API :3900
pnpm dev
# 터미널 2 — 웹 :5173 (Vite가 /api, /ws 프록시)
pnpm dev:client
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
pnpm verify:full   # 서버 타입 체크 + 서버 테스트 + 클라이언트 테스트 + 서버·클라이언트 빌드
pnpm test:e2e      # 빌드 후 Chrome 2개로 가입→대화→새로고침→DB 평문 부재 검증
pnpm verify:all    # 위 두 가지를 순차 실행
# 외부 DB: TEST_DATABASE_URL=postgres://... pnpm test
# E2E DB: E2E_DATABASE_URL=postgres://... pnpm test:e2e (이름에 'e2e' 포함 필요)
# E2E는 시스템 Chrome(channel)을 사용한다. 브라우저 바이너리는 내려받지 않는다.
```

프로덕션 빌드는 `pnpm build` 하나로 서버(`dist/`)와 클라이언트(`client/dist/`)를 모두 만들고,
서버가 같은 도메인에서 클라이언트를 서빙한다.

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
