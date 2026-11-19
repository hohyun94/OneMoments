# OneMoments

개인용 **종단간 암호화(E2E) 메신저**(1:1·소규모 그룹), 웹 우선. 서버는 평문·대화 키·기기 개인키를 갖지 않고 **암호문 봉투만** 저장·중계한다.

**현재 단계: Post-MVP 기능 확장 (웹/PWA 기준, 네이티브 앱은 범위 외)**

## 구현된 것

- **웹 클라이언트** (`client/`): React 19 + Vite + Tailwind, 로그인/가입, 대화 목록, 채팅, 기기 관리, **연락처 관리**, **다크 모드·강조색 테마(프리셋/HEX, 계정 동기화)**
- **E2E 암호화**: 브라우저에서 X25519/Ed25519 키 생성·보관(IndexedDB), 기기별 키 봉투, Ed25519 서명 검증
- **키 백업·기기 복구**: 복구 암호(PBKDF2+AES-GCM)로 기기 키를 암호화해 서버에 저장, 새 브라우저에서 복구(같은 기기 ID·이력 유지)
- **안전번호**: 활성 기기 공개키 지문(60자리) 표시, 기기 키 변경 시 경고 배너
- **계정/세션**: scrypt 비밀번호, HttpOnly 세션 쿠키, CSRF + Origin 가드, **같은 기기 재로그인 시 세션 회전**, **기기·세션별 무활동 자동 로그아웃(1~30분, 기본 5분·끄기 불가)**
- **삭제 정책**: 대화 숨김(내 화면만), **계정 익명화 삭제**(상대 이력 유지), **이 기기 키 삭제** 옵션
- **기기**: 키 등록·폐기, 폐기 시 세션 무효, 새 기기는 이후 메시지만 수신
- **대화**: 1:1 중복 방지, 그룹 대화(최대 20명·소유자·이름 변경·참여자 추가·나가기), **초대 링크(7일·최대 10명)**, **그룹 Sender Keys**, 대화별 알림 음소거, **읽음 표시·읽지 않은 메시지 배지**, 실시간 수신·타이핑·presence, **Moments(24시간 선택 공개 스토리, 암호화 이미지·조회 기록)**
- **프로필·연락처**: **상태 메시지(공개 프로필, 최대 80자)**, **연락처 즐겨찾기**, **1:1 차단/해제(양방향 전송 차단)**, 즐겨찾기 우선 정렬
- **메시지**: AES-256-GCM 암호문 + 기기별 봉투, **X3DH signed prekey·Double Ratchet(v2)**, 서명, 멱등 전송, 기기 집합 검증(409), 복호화 실패 표시, **읽은 뒤 자동 삭제(대화별 1·7·30일, 참여자 전원 읽음 기준)**, **이모지 반응·답장·수정·삭제(발신자)**, **로컬(IndexedDB) 검색**
- **파일 첨부**: 파일별 AES-GCM 암호화 후 암호문만 업로드, **이미지 인라인 미리보기**, 로컬/S3 저장 선택, 고아 첨부 TTL 정리, 참여자만 다운로드
- **푸시·PWA**: VAPID Web Push(RFC 8291), 서비스 워커, **오프라인 앱 셸**, PNG 192/512 아이콘, 로그아웃/기기 폐기 시 구독 정리
- **성능**: 동시성 부하 테스트(Node/k6), 클라이언트 DR·첨부 암복호화 벤치마크
- **운영**: 프로덕션 UI 서빙 + CSP, `/metrics`(Prometheus), Redis/Dragonfly 다중 인스턴스 팬아웃, 마이그레이션 일회성 실행, 백업/복구 스크립트, 부하 테스트, 슬림 런타임 이미지
- **관리자 콘솔**: `ADMIN_USERNAMES` allowlist 전용 `/admin` — 개요 통계, 사용자·기기·세션 조회, 세션 강제 종료, decoy 프로필 웹 관리, 감사 로그(메타데이터만)
- **테스트 154개**: 서버 107(106 passed·1 skipped: 단위·API·WS·버스·푸시·초대·첨부 정리·decoy·관리자·자동 로그아웃·자동 삭제·테마·대화 UX·Moments·프로필/연락처) + 클라이언트 40(DR·X3DH/OPK·Sender Keys·첨부·백업·프로필 저장·자동 로그아웃 정책·자동 삭제 옵션·테마·검색·Moments) + 브라우저 E2E 7(그룹·초대·이미지·자동 로그아웃·오프라인)

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
| `ADMIN_USERNAMES` | — | 관리자 콘솔 allowlist(쉼표 구분, 소문자 username). 비우면 관리자 기능 비활성 |
| `DB_POOL_MAX` | — | `5` (인스턴스 수 × 값 ≤ DB max_connections) |
| `METRICS_TOKEN` | — | `/metrics` Bearer 토큰(운영 권장) |
| `REDIS_URL` | — | 기본 `redis://redis:6379` (compose에 Redis 포함) |
| `MIGRATE_ON_START` | — | 기본 `true`. 다중 인스턴스에서는 `false` |
| `BACKUP_MAX_BYTES` | — | 키 백업 블롭 최대 크기(기본 8MB, DR 세션·이력 키 포함) |
| `RECOVERY_CHALLENGE_TTL_SECONDS` | — | 복구 챌린지 유효 시간(기본 300초) |
| `ATTACHMENT_MAX_BYTES` | — | 첨부 암호문 최대 크기(기본 8MB) |
| `ATTACHMENT_DIR` | — | 첨부 저장 경로(compose에서 `/app/data/attachments` + 볼륨) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | — | Web Push VAPID 키(`pnpm push:keys`). 없으면 푸시 비활성 |
| `VAPID_SUBJECT` | — | `mailto:` 또는 `https://` 연락처 |
| `PUSH_TTL_SECONDS` | — | 푸시 보관 TTL(기본 3600) |

3. `app` 서비스에 도메인을 연결하고 **포트 8080**, HTTPS를 켠다.
4. 배포 → 기동 시 `scripts/start.mjs`가 마이그레이션을 적용한 뒤 서버를 띄운다.
5. 확인: `https://<도메인>/healthz`, `/readyz`, 로그인 후 쿠키가 `Secure; HttpOnly`인지 확인.

자세한 절차·백업·트러블슈팅: [`docs/05-deploy-coolify.md`](docs/05-deploy-coolify.md)

> compose에는 메시지 팬아웃용 **Redis**가 포함되어 있다. Dragonfly를 쓰려면 image만 교체하면 된다(Redis 호환).
> 여러 인스턴스로 늘릴 때는 `MIGRATE_ON_START=false`로 두고 마이그레이션을 일회성으로 실행한다
> (`docs/06-operations.md`).

> Coolify의 **내장 PostgreSQL 리소스**를 쓰려면 compose에서 `postgres` 서비스를 제거하고,
> `DATABASE_URL`을 그 리소스의 내부 주소로 지정하면 된다(백업·모니터링은 Coolify가 관리).

## 검증

```bash
pnpm verify:full   # 서버 타입 체크 + 서버 테스트 + 클라이언트 테스트 + 서버·클라이언트 빌드
pnpm test:e2e      # 빌드 후 Chrome 2개로 가입→대화→새로고침→DB 평문 부재 검증
pnpm verify:all    # 위 두 가지를 순차 실행
# 운영 도구
pnpm db:backup     # BACKUP_DOCKER_CONTAINER 또는 pg_dump
pnpm db:load-test  # BASE_URL, MESSAGE_COUNT
pnpm messages:cleanup  # 읽은 뒤 자동 삭제 정리(크론 권장)
pnpm moments:cleanup   # 만료된 Moments·고아 이미지 정리(크론 권장)
# 외부 DB: TEST_DATABASE_URL=postgres://... pnpm test
# E2E DB: E2E_DATABASE_URL=postgres://... pnpm test:e2e (이름에 'e2e' 포함 필요)
# E2E는 시스템 Chrome(channel)을 사용한다. 브라우저 바이너리는 내려받지 않는다.
```

프로덕션 빌드는 `pnpm build` 하나로 서버(`dist/`)와 클라이언트(`client/dist/`)를 모두 만들고,
서버가 같은 도메인에서 클라이언트를 서빙한다.

## 암호화 모델 요약

- 클라이언트: 콘텐츠 키(AES-256-GCM) + X3DH(OPK·signed prekey) 또는 레거시 X25519 ECDH→HKDF 봉투 + Ed25519 서명
- 서버: `ciphertext`, 기기별 `wrapped_key`, 서명만 보관. **복호화 경로 없음**
- 규격·위협 모델·데이터 모델: [`docs/02-architecture.md`](docs/02-architecture.md)

## 문서

- [제품 정의](docs/00-product.md) — 타깃, 핵심 시나리오, MVP 범위, 확정 결정
- [요구사항](docs/01-requirements.md) — 기능/비기능 요구사항과 수용 기준
- [아키텍처·보안 설계](docs/02-architecture.md) — E2E 암호 설계, 데이터 모델, API, 위협 모델
- [화면 와이어프레임](docs/04-wireframes.md) — 로그인·대화 목록·채팅·기기/안전번호
- [로드맵](docs/03-roadmap.md) — 마일스톤과 완료 기준
- [Coolify 배포](docs/05-deploy-coolify.md) — PostgreSQL 컨테이너, 환경변수, 백업, 트러블슈팅
- [운영 가이드](docs/06-operations.md) — 다중 인스턴스(Redis/Dragonfly), 마이그레이션, 모니터링, 부하 테스트
- [백업·복구](docs/07-backup-restore.md) — pg_dump/restore, Coolify 예약 작업, 리허설 체크리스트
- [키 백업·기기 복구](docs/08-key-backup.md) — 복구 암호, 백업 블롭, 복구 절차와 한계
- [그룹 대화](docs/09-groups.md) — 기기별 봉투, 참여자 추가, 인원 제한과 한계
- [파일 첨부](docs/10-attachments.md) — 파일별 암호화, 저장·접근 제어, 백업과 한계
- [Double Ratchet](docs/11-double-ratchet.md) — v2 세션·DH 래칫, 이력 키, 백업과 한계
- [Sender Keys](docs/14-sender-keys.md) — 그룹 체인 배포, 회전, 백업과 보안 한계
- [X3DH](docs/15-x3dh.md) — signed prekey, 최초 세션, 백업과 OPK 후속
- [네이티브 앱 평가(참고, 범위 외)](docs/16-native-app.md) — React Native/Flutter, 키 보관, APNs/FCM, 결정 게이트
- [로컬 웹 테스트](docs/17-web-test.md) — 브라우저/PWA 접속 URL, 시나리오, 환경 초기화
- [Decoy 프로필](docs/18-decoy-profile.md) — 배포 관리자 CLI·관리자 콘솔, 별도 비밀번호, 격리와 한계
- [관리자 콘솔](docs/21-admin-console.md) — `ADMIN_USERNAMES`, 메타데이터 조회, 세션 강제 종료, decoy 웹 관리, 감사 로그
- [자동 로그아웃](docs/19-auto-logout.md) — 기기·세션별 1~30분(기본 5분), 메모리 캐시 제거, 강제 로그인
- [읽음 표시](docs/20-read-receipts.md) — 읽음 커서 API, 1:1/그룹 표기, 5초 갱신
- [읽은 뒤 자동 삭제](docs/22-auto-delete.md) — 대화별 옵션, 전원 읽음 기준, 서버 삭제와 크론
- [화면 테마](docs/23-accent-theme.md) — 다크 모드, 프리셋/HEX 강조색, 계정 동기화
- [대화 UX](docs/24-conversation-ux.md) — 반응·답장·수정·삭제, 로컬 검색
- [Moments](docs/25-moments.md) — 24시간 선택 공개 스토리, 암호화 이미지, 조회
- [프로필·연락처](docs/26-contacts-profile.md) — 상태 메시지, 즐겨찾기, 1:1 차단/해제와 한계
- [푸시·PWA](docs/12-push-mobile.md) — Web Push, VAPID, 서비스 워커, 모바일 대응
- [성능·부하 테스트](docs/13-performance.md) — 동시성·k6, 클라이언트 암복호화 프로파일링

## 원칙

1. 서버는 **평문·대화 키·기기 개인키**를 갖지 않는다.
2. 결정은 문서에 먼저 남긴다.
3. 개인정보는 최소한으로 수집한다(메타데이터 포함).
