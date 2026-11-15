# 로드맵 — OneMoments

각 마일스톤은 **완료 기준(Exit criteria)** 을 만족할 때만 다음으로 넘어간다.
기간 추정은 팀 상황에 맞춰 별도로 잡고, 여기서는 순서와 범위만 고정한다.

## M0. 기획 확정 (현재)

**산출물**
- 제품 정의·요구사항·아키텍처·로드맵 문서
- 핵심 결정(D-1~D-6·D-8) 확정
- 핵심 화면 4종 와이어프레임: 로그인/가입, 대화 목록, 채팅, 기기/안전번호

**완료 기준**
- [x] 핵심 결정 D-1~D-6·D-8 확정(다중 기기·username·Ed25519 서명·새 기기 UX·삭제 정책·UI 스택·브라우저 범위)
- [x] E2E 암호 흐름(키 봉투)에 대한 합의
- [x] 핵심 화면 와이어프레임 작성(`docs/04-wireframes.md`)
- [ ] 제품 문서·API 계약·와이어프레임 리뷰

## M1. 서버 코어

**범위**: FR-01~05, FR-07 / NFR-01, 03, 04, 07, 12

- 리포 구조, PostgreSQL 마이그레이션, 세션 인증(쿠키)
- 기기 공개키 등록·폐기, 사용자 검색, 1:1 대화
- 암호문·기기별 키 봉투 저장, 기기 집합 일치 검증, 멱등 전송
- 이력 조회(커서), WebSocket 구독·전송·타이핑·presence
- 통합 테스트: 평문 부재, 권한, 멱등, 봉투 검증

**완료 기준**
- [x] 서버 응답·로그·DB 어디에도 평문이 없음을 테스트로 증명 (`test/api-messages.test.ts`, `test/ws.test.ts`)
- [x] 비멤버 접근 차단, 폐기 기기 세션 무효 (`test/api-auth.test.ts`, `test/ws.test.ts`)
- [x] `409 DEVICE_SET_CHANGED` 흐름 테스트 (`test/api-messages.test.ts`)
- [x] WebSocket 기기별 봉투 전달 테스트 (`test/ws.test.ts`)

## M2. 웹 클라이언트

**범위**: FR-01~07, FR-09 / NFR-02, 05, 09, 10

- 기기 키 생성·보관(IndexedDB), 가입/로그인/로그아웃
- 사용자 검색, 대화 목록, 채팅 화면(전송·수신·이력)
- 실시간 수신, 재연결·오프라인 동기화
- 복호화 실패 메시지 표시(추정 금지)
- 두 브라우저 E2E 시나리오 자동화

**완료 기준**
- [x] 클라이언트 구현: 키 생성·보관, 가입/로그인/로그아웃, 대화 목록·채팅, 실시간 수신, 이력, 복호화 실패 표시
- [x] 기기 키가 새로고침 후에도 유지되고 기기가 중복 생성되지 않음(IndexedDB)
- [x] 클라이언트 암호화 단위 테스트(백엔드별·교차 백엔드·변조 감지)
- [x] 브라우저 2개 자동 E2E(Playwright): 가입→대화→양방향 수신→새로고침 후 복호화→기기 1개→DB 평문 부재

## M3. 보안 강화

**범위**: FR-08, FR-10 / NFR-04, 11

- 안전번호 표시·변경 경고, 기기 관리 화면
- 대화 숨김 + 계정 익명화 삭제(상대 이력에 "삭제된 사용자" 유지)
- CSP·CSRF·Origin·세션 회전, 보안 회귀 테스트
- 이 기기 키 삭제 옵션(키를 지우고 로그아웃), 기기 폐기 UX

**완료 기준**
- [x] 위협 모델 표의 완화 항목이 코드/테스트로 매핑됨
- [x] CSRF·Origin 차단, CSP 헤더, 세션 회전 테스트
- [x] 기기 키 변경 시 안전번호 경고 표시
- [x] 계정 삭제 후 상대 이력 유지·읽기 전용 (서버·E2E 테스트)

## M4. 운영·배포

**범위**: NFR-06, 08 및 배포

- Docker 이미지, 외부 PostgreSQL, 마이그레이션 배포 job
- 백업/PITR + 복구 리허설, 모니터링·알림
- 다중 인스턴스 전략: Redis/Dragonfly 팬아웃(구현), presence는 sticky 또는 후속
- 부하 테스트(동시 연결·메시지 처리량)

**완료 기준**
- [x] 복구 리허설 문서화 및 1회 수행 (`docs/07-backup-restore.md`)
- [x] 배포·롤백 절차 문서화 (`docs/05`, `docs/06`)
- [x] `/healthz`·`/readyz` 모니터링 + `/metrics`(Prometheus)
- [x] 다중 인스턴스 팬아웃(Redis/Dragonfly) + 테스트
- [x] 부하 테스트 스크립트·기준 측정
- [x] 슬림 런타임 이미지(`pnpm deploy`, 556MB → 288MB, S3 SDK 포함 312MB)

## Post-MVP 진행

MVP 이후 과제를 순차 진행한다.

1. **키 백업·기기 복구** — 완료
   - 복구 암호로 기기 키를 암호화해 서버에 저장, 새 브라우저에서 같은 기기 ID로 복구
   - `docs/08-key-backup.md`
2. 그룹 대화·파일 첨부 — **완료**
   - 그룹 대화(최대 20명, Sender Keys, 참여자 추가/이름 변경/나가기) · `docs/09-groups.md`
   - 파일 첨부(파일별 AES-GCM, 암호문만 저장) · `docs/10-attachments.md`
   - Sender Keys 최적화 — 완료 · `docs/14-sender-keys.md`
3. **Double Ratchet(v2)** — 완료
   - **X3DH**: 최초 v2 세션은 상대 signed prekey가 있으면 X3DH(3-DH)로 초기화한다. SPK private는 백업에 포함한다.
   - **X3DH signed prekey** 최초 세션 — 완료 · `docs/15-x3dh.md`
   - **원타임 프리키(OPK)·SPK 30일 회전 — 완료**
   - 백업에 DR 세션·이력 키·SPK/OPK private 포함 · `docs/11-double-ratchet.md`
4. 푸시 알림·웹/PWA
   - **Web Push(VAPID)·PWA(오프라인 앱 셸, PNG 아이콘)·대화별 음소거 — 완료** · `docs/12-push-mobile.md`
   - **네이티브 앱 — 현재 제품 범위에서 제외**(참고 평가만 유지) · `docs/16-native-app.md`
5. **부하 테스트 동시성·클라이언트 프로파일링** — 완료
   - Node `CONCURRENCY`, k6 HTTP 시나리오, `bench:crypto`
   - 로컬 200건/동시성 20: 302.6 msg/s, REST p95 103.5ms · `docs/13-performance.md`
6. 후속: 읽지 않은 메시지 배지·읽음 커서, 그룹 관리(owner 역할), 대화 음소거, PWA 오프라인 — 완료
   - 그룹 초대 링크 — 완료 · `docs/09-groups.md`
   - 첨부 S3 옵션·고아 TTL 정리 — 완료 · `docs/10-attachments.md`
   - 오프라인 캐시 버전 E2E — 완료 · `docs/12-push-mobile.md`
7. **Decoy 프로필(배포 관리자 전용)** — 완료 · `docs/18-decoy-profile.md`
   - 실제 ID + 관리자 설정 decoy 비밀번호 → 별도 프로필
   - 일반 사용자 UI/API에는 존재 비노출
8. **관리자 콘솔** — 완료 · `docs/21-admin-console.md`
   - `ADMIN_USERNAMES` allowlist, 개요·사용자/기기/세션 조회, 세션 강제 종료
   - decoy 프로필 웹 관리, 감사 로그(메타데이터만)

## 리스크

| 리스크 | 대응 |
|---|---|
| 브라우저 WebCrypto X25519/Ed25519 지원 차이 | `@noble/curves` 폴백, 최소 브라우저 매트릭스 확정(D-8) |
| 다중 기기 UX 혼란(과거 이력 없음) | 로그인·기기 추가 화면에서 명시, D-4 확정 |
| XSS 한 번으로 E2E 무력화 | CSP·서드파티 금지·non-extractable 키, M3 보안 테스트 |
| 서버 검색 불가로 인한 UX 제약 | 클라이언트 측 검색·대화 목록 필터로 한정 |
| 운영 복잡도(마이그레이션·다중 인스턴스) | M4에서 배포 job·Redis 전략 확정 |
