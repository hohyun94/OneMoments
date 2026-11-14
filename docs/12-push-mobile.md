# 푸시 알림·PWA

웹 클라이언트에 **Web Push**와 설치형 PWA를 추가했다. 서버는 메시지 내용을 모르는 채 **일반 알림 문구와 대화 ID만** 전송한다.

## 1. 구성

| 구성 | 내용 |
|---|---|
| 서버 | `push_subscriptions` 테이블, VAPID ES256 JWT, RFC 8291(aes128gcm) 암호화, `fetch`로 푸시 서비스 호출 |
| 클라이언트 | 서비스 워커(`/sw.js`), `PushManager` 구독, 기기 관리의 **알림** 카드 |
| PWA | `manifest.webmanifest`, SVG 아이콘, standalone 표시 |
| 트리거 | 새 메시지 저장 직후 참여자들의 구독으로 비동기 전송(발신 기기 제외) |

## 2. VAPID

```bash
pnpm push:keys
# VAPID_PUBLIC_KEY=...
# VAPID_PRIVATE_KEY=...
# VAPID_SUBJECT=mailto:you@example.com
```

- 공개키: uncompressed P-256 65바이트 base64url
- 개인키: 32바이트 base64url. **환경변수에만** 보관한다.
- 서버는 공개/개인 키가 실제 같은 키 쌍인지 시작 시 검증한다.
- 키를 한 번 정하면 유지한다. 교체하면 기존 구독이 무효화될 수 있어 사용자가 다시 알림을 켜야 한다.
- VAPID JWT는 audience(푸시 서비스 origin)별로 12시간 캐시한다.

## 3. 구독 API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/push/public-key` | VAPID 공개키(세션 필요). 미설정 시 503 |
| POST | `/api/push/subscriptions` | `{endpoint, keys:{p256dh, auth}}` 저장/갱신 |
| DELETE | `/api/push/subscriptions` | `{endpoint}` 구독 삭제 |

- endpoint는 HTTPS(로컬 테스트는 localhost HTTP 허용), p256dh 65바이트, auth 16바이트를 검증한다.
- SSRF 방지를 위해 **FCM·Mozilla autopush·Apple·WNS 호스트만** 허용하고, 푸시 요청은 리다이렉트를 거부한다.
- endpoint는 unique. 같은 브라우저에서 다른 계정으로 로그인하면 최신 사용자/기기로 갱신된다.
- 로그아웃·기기 폐기·계정 삭제 시 해당 구독을 삭제한다.
- 푸시가 설정되지 않은 서버에서는 `PUSH_DISABLED`(503)를 반환하고 UI는 “서버에서 설정되지 않음”을 표시한다.

## 4. 알림 payload

```json
{
  "type": "message",
  "title": "OneMoments",
  "body": "새 메시지가 도착했습니다.",
  "conversationId": "...",
  "messageId": "...",
  "tag": "onemoments-<conversationId>"
}
```

- **메시지 내용·발신자·파일 이름/MIME은 포함하지 않는다.**
- 클릭하면 `/c/<conversationId>`를 열고, 앱이 서버에서 암호문을 받아 복호화한다.
- 같은 대화의 알림은 `tag`로 교체된다.
- TTL 기본 3600초. 푸시 서비스가 404/410을 주면 구독을 삭제하고, 그 외 실패는 `failure_count`만 증가시킨다.

## 5. 클라이언트

- 기기 관리 → **알림** 카드에서 `알림 켜기`/`알림 끄기`.
- 권한 요청은 사용자 클릭에서만 수행한다.
- 서비스 워커는 알림 표시와 클릭 이동만 담당하며 앱 자산을 캐시하지 않는다(오프라인 캐시는 후속).
- 로그아웃 시 브라우저 구독을 해제하고 서버 행도 지운다.

## 6. PWA·모바일

- `manifest.webmanifest` + `display: standalone` + **PNG 192/512·Apple 180 아이콘**으로 홈 화면 설치를 지원한다.
- 서비스 워커가 정적 앱 셸(`/`, `/assets/*`, 아이콘·매니페스트)을 캐시한다. API·첨부 암호문은 캐시하지 않는다.
- iOS Safari는 **홈 화면에 추가한 PWA에서만** Web Push를 지원한다. 일반 탭에서는 알림을 켤 수 없다.
- Android Chrome은 일반 탭에서도 Web Push를 지원한다.
- 현재 아이콘은 PNG 192/512·Apple 180을 생성해 포함한다(`pnpm icons:pwa`). 스토어용 추가 사이즈는 후속.
- **네이티브 앱은 아직 없다.** 다음 단계 후보:
  - React Native/Flutter 클라이언트에서 기존 프로토콜(v1/v2 봉투, DR 세션) 재사용
  - 푸시는 APNs/FCM 토큰을 `push_subscriptions`와 유사한 테이블로 저장
  - 기기 키·DR 세션을 OS 보안 저장소(Keychain/Keystore)로 이전

## 7. 운영

- HTTPS 필수(서비스 워커·Push API). 리버스 프록시에서 TLS 종료.
- VAPID 키는 Coolify 환경변수로 주입한다. 없으면 푸시만 비활성화되고 나머지는 동작한다.
- 푸시 서비스 장애는 메시지 전달에 영향을 주지 않는다(비동기, 실패 로그만).
- 엔드포인트 원문은 로그에 남기지 않는다(구독 ID만).
- 서버가 허용 목록에 없는 자체 푸시 서버로 보내지는 않는다. 자체 푸시 인프라를 쓰려면 허용 목록을 확장해야 한다.
- 사용자별 알림 설정·방해 금지·대화별 음소거는 아직 없다.

## 8. 검증

- 서버 단위: RFC 8291 암복호화 왕복, VAPID ES256 서명 검증, mock 푸시 엔드포인트로 실제 POST·payload 확인,
  메시지 알림 payload에 평문 없음, 구독 저장/삭제, VAPID 미설정 503
- 클라이언트 빌드: 서비스 워커·매니페스트가 `dist`에 포함되고 PWA 링크가 주입됨
- 브라우저 E2E는 실제 푸시 서비스(FCM 등) 의존성 때문에 제외한다. HTTPS 환경에서 수동 확인 절차:
  1. `pnpm push:keys`로 키 설정 후 서버 기동
  2. 기기 관리 → 알림 켜기 → 권한 허용
  3. 다른 계정에서 메시지 전송 → 알림 표시 → 클릭 시 해당 대화 열림
