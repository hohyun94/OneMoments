# 위치 공유 (E2E)

대화에서 **현재 위치를 좌표로 보내는 기능**. 좌표는 메시지 암호문 **안에만** 존재하고
서버·TURN·DB 어디에도 평문 좌표가 남지 않는다(기존 종단간 암호화 경로 재사용, 서버 변경 없음).

## 1. 무엇이 가능하고 무엇이 불가능한가

| 요구 | 가능 여부 | 이유 |
|---|---|---|
| "세션의 기기정보(devices/sessions)에서 위치를 읽어 서버가 제공" | ❌ 불가능 | `devices` 는 `name`·`platform`(ios/android/mobile/desktop/unknown) 만, `sessions` 는 `user_agent` 만 저장한다. 브라우저의 GPS/Wi-Fi 측위는 **페이지에만** 노출되며 서버 API 로 조회할 수 없다 |
| 사용자가 허용하면 그 기기의 현재 위치를 읽어 표시/공유 | ✅ 가능 | `navigator.geolocation.getCurrentPosition` (HTTPS·사용자 권한·사용자 제스처) |
| 접속 IP 로 대략적 지역 추정 | ✅ 가능(별도 기능) | `auth_events.ip` 는 이미 저장 중. 다만 도시 단위 오차가 커서 "정확한 위치"로 쓸 수 없다 |

이 문서는 **첫 번째 대안(위치 공유 메시지)** 만 다룬다. IP 기반 지역 표시는 별도 설계 대상이다.

## 2. 메시지 형식

첨부(`onemoments:attachment:v1:`)·모먼트와 같은 방식으로, **암호화된 평문 문자열** 안에 접두사를 붙인다.

```
onemoments:location:v1:<base64(JSON)>
```

```json
{ "lat": 37.5665, "lng": 126.978, "accuracy": 20, "at": "2026-11-23T12:00:00.000Z", "label": "집" }
```

| 필드 | 검증 |
|---|---|
| `lat` / `lng` | `-90..90` / `-180..180`, 유한수 |
| `accuracy` | `0..100000`(미터, 0=미상) |
| `at` | `Date.parse` 가능한 ISO 8601 |
| `label` | 선택, 최대 80자 |

형식이 어긋나면 `parseLocationPayload` 가 `null` 을 돌려주고 **일반 텍스트 메시지로** 표시한다(전방 호환).

## 3. 흐름

```
[보내는 사람]                                   [서버]                        [받는 사람]
 위치 버튼 클릭(사용자 제스처)
 → 권한 프롬프트 → getCurrentPosition
 → 미리보기(좌표·정확도·장소 이름) → 보내기
 → onemoments:location:v1:… 를 기존 텍스트 전송 경로로 전송
        └─ E2E 암호화(기존 봉투) ─────────────▶ 암호문만 저장/중계 ─────────▶ 복호화 → 위치 카드
                                                                              (좌표 + 정확도 + 지도 링크)
```

- 전송은 `kind: "text"` 기존 경로를 그대로 쓴다 → 저장·전달·자동 삭제·백업·내보내기 정책이 동일하게 적용된다.
- 수신 측은 카드(`data-testid="location-card"`)로만 렌더하고 base64 본문을 노출하지 않는다.
- 검색 인덱스에는 좌표 대신 **"위치 공유" + 장소 이름**만 저장한다.
- 답장 미리보기는 "위치 공유" 로 표시하고, **위치 메시지는 수정할 수 없다**(첨부와 동일).

## 4. 프라이버시·보안

- 위치는 **사용자가 버튼을 누르고 권한을 허용한 경우에만** 읽는다. 백그라운드 추적·주기 전송은 없다.
- 서버는 좌표를 볼 수 없다(암호문 안). DB 컬럼·감사 로그에도 남기지 않는다.
- 지도는 **임베드하지 않는다**. 카드의 "지도에서 열기" 는 OpenStreetMap 외부 링크(새 탭, `noopener noreferrer`)라
  CSP(`img-src`/`connect-src 'self'`)를 완화할 필요가 없다.
- 보안 헤더에 `Permissions-Policy: geolocation=(self), microphone=(self), camera=(self)` 를 추가해
  같은 출처만 위치·마이크·카메라를 쓸 수 있게 한다(CSP 지시자가 아니므로 별도 헤더).
- 권한 거부/시간 초과/사용 불가를 각각 안내한다(`locationFailureMessage`).
- **법·정책**: 사용자가 직접 보내는 좌표라도 개인정보 처리방침에 "위치정보 처리(수집 항목·목적·보유기간·거부 방법)"를
  명시해야 한다. 실시간 추적·자동 공유로 확장하면 「위치정보의 보호 및 이용 등에 관한 법률」 검토가 선행되어야 한다.

## 5. 구현 파일

| 파일 | 역할 |
|---|---|
| `client/src/lib/location.ts` | 접두사·`encode`/`parse`(범위 검증)·좌표/정확도 포맷·OSM 링크 |
| `client/src/lib/geolocation.ts` | `requestCurrentLocation()` 래퍼, 오류 코드 매핑(`denied`/`timeout`/`unavailable`/`unsupported`), 사용자 문구 |
| `client/src/components/LocationShareDialog.tsx` | 권한 요청 → 미리보기 → 장소 이름(선택) → 전송 |
| `client/src/components/LocationCard.tsx` | 메시지 카드(좌표·정확도·지도 링크) |
| `client/src/components/MessageBubble.tsx` | 복호화 결과에서 위치 payload 분리, 카드 렌더, 검색·답장·수정 처리 |
| `client/src/components/ChatView.tsx` | 입력창 **위치 공유** 버튼, 전송 핸들러 |
| `src/app.ts` | `Permissions-Policy` 헤더 |
| `client/src/lib/location.test.ts`, `geolocation.test.ts`, `e2e/chat.spec.ts` | 단위·E2E 검증 |

## 6. 검증

| 계층 | 내용 |
|---|---|
| 단위 | 인코딩/파싱 왕복, 잘못된 base64·범위·날짜·라벨 거부, 좌표/정확도/지도 링크 포맷, 권한 오류 매핑 |
| 서버 | `Permissions-Policy` 헤더 존재 + CSP 에 위치 지시자가 섞이지 않음 |
| E2E | Playwright `context({ geolocation, permissions:["geolocation"] })` → 위치 버튼 → 미리보기(37.56650, 126.97800) → 전송 → **양쪽에 카드**, base64 본문 미노출 |

## 7. 한계·후속

- 정확도는 기기·환경에 따라 다르다(GPS 5~20m, Wi-Fi 20~100m, 셀 300m~수 km). 카드에 정확도를 함께 보여준다.
- 실시간 위치 추적/공유(지속 갱신)는 지원하지 않는다. 필요하면 별도 동의·만료·E2E 설계가 필요하다.
- 지도 미리보기(타일)는 CSP·프라이버시 영향이 있어 도입하지 않았다. 필요하면 자체 타일 프록시와 정책을 먼저 정한다.
- IP 기반 "최근 접속 지역"(관리/보안 화면)은 별도 기능으로 남겨 둔다.
