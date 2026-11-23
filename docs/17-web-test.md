# 로컬 웹 테스트 가이드

네이티브 앱 없이 브라우저/PWA로 테스트하는 환경이다.

## 1. 접속 URL

| 대상 | URL | 비고 |
|---|---|---|
| 같은 PC | http://localhost:3900 | 서비스 워커·PWA 가능(secure context) |
| 같은 LAN | http://192.168.55.150:3900 | 채팅 가능. PWA/Web Push는 HTTPS 필요 |
| Tailscale | https://desktop.tail1d0ae1.ts.net/ | tailnet 전용, HTTPS라 PWA/Web Push 가능 |

- 서버는 `PORT=3900`, `NODE_ENV=development`로 실행된다.
- 테스트 DB는 `onemoments_web`(E2E/개발 DB와 분리).
- Tailscale HTTPS는 `tailscale serve --bg 3900`으로 프록시한다.
  - 해제: `tailscale serve --https=443 off`

## 2. 실행·중지

```powershell
cd C:\H_PROJECT\OneMoments

# 실행 (dist + .env 사용, DB 마이그레이션 자동 적용: scripts/start.mjs)
pnpm start:web

# 코드 변경 후
pnpm build
pnpm start:web

# 중지
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3900 -State Listen).OwningProcess -Force
```

로그: `.web.out` / `.web.err`

### DB 마이그레이션 (중요)

`pnpm start` 는 마이그레이션을 **실행하지 않는다**(`dist/server.js` 직접 실행). 새 마이그레이션이 있는 커밋을 받은 뒤
`pnpm start` 로만 재기동하면 **스키마가 뒤처져** 로그인/가입 후 화면이 비어 보이거나 API 가 500 을 낸다.
그래서 로컬 웹 테스트는 **`pnpm start:web`(=`scripts/start.mjs`, `MIGRATE_ON_START` 기본 true)** 을 쓴다.

이미 뒤처진 DB 라면 수동으로 한 번 적용한다.

```powershell
pnpm db:migrate   # .env 의 DATABASE_URL(onemoments_web)에 적용
pnpm start:web
```

증상 예: 가입은 되는데 대화 목록이 안 뜸, `users.oauth_provider does not exist` / `/api/auth/me` 500,
브라우저 창이 빈 화면 → 위 마이그레이션 후 새로고침(필요 시 `Ctrl+Shift+R`).

## 3. 테스트 시나리오

브라우저 프로필을 2개(일반 창 + 시크릿 창) 열고 서로 다른 계정으로 가입한다.

1. **1:1**: 새 대화 → 상대 검색 → 메시지 전송/수신, 새로고침 후 이력 유지
2. **파일**: 파일 선택 → 전송 → 상대 다운로드
3. **그룹**: 그룹 생성(3명) → 메시지/답장 → 참여자 추가 → 이름 변경 → 나가기
4. **알림/읽음**: 대화별 음소거, 목록의 읽지 않음 배지, 대화 열면 읽음 처리
5. **백업/복구**: 기기 관리 → 백업 암호 설정 → 시크릿 창에서 복구
6. **PWA**: localhost/HTTPS에서 DevTools → Application → Manifest/Service Workers
7. **오프라인**: 새로고침 전에 DevTools Network → Offline → 앱 셸 로드 확인

> 두 계정 모두 **각 브라우저에 키가 생성**된다. 계정 비밀번호만으로 다른 브라우저에서 로그인하면
> 새 기기로 등록되어 과거 이력은 복호화되지 않는다(의도된 E2E 동작). 이력 테스트는 백업/복구를 사용한다.

## 4. PWA/Web Push 주의

- `localhost`와 HTTPS(Tailscale)만 secure context다. `http://192.168...`에서는 서비스 워커·푸시가 등록되지 않는다.
- iOS Web Push는 **iOS 16.4+**, 홈 화면에 추가한 PWA에서만 동작한다.
- 알림 권한은 브라우저 UI에서 허용해야 한다.
- VAPID 키는 `.env`에만 있고 저장소에 커밋하지 않는다.

## 5. 환경 초기화

```powershell
# 테스트 DB만 초기화 (파괴적)
docker exec onemoments-postgres dropdb -U onemoments --if-exists onemoments_web
docker exec onemoments-postgres createdb -U onemoments onemoments_web
pnpm db:migrate
```

첨부 파일은 `data/attachments-web/`에 저장된다. 필요 시 해당 디렉터리를 비운다.
