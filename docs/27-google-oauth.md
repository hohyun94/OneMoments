# Google OAuth(가입·로그인·계정 연결)

Google 계정으로 가입·로그인하고, 기존 비밀번호 계정에 Google 을 연결한다.
**1단계(서버)** 가 완료되었고, 클라이언트 UI 는 2단계에서 붙인다.

## 1. 보안 모델

| 항목 | 내용 |
|---|---|
| 비밀번호 | Google 전용 계정은 **비밀번호가 없다**(`users.password_hash = null`) |
| 서버가 아는 것 | `oauth_provider`, `oauth_subject`(Google `sub`), 기기 공개키, 세션 |
| 서버가 모르는 것 | 기기 개인키, DR 세션·이력 키, 메시지·첨부 평문, 복구 암호 |
| E2E 영향 | **없음**. 비밀번호는 원래 인증 전용이고, 키 백업은 별도 복구 암호(PBKDF2)를 쓴다 |
| 이메일 | 완료 단계에서만 잠시 쓰고 **티켓 소비 시 삭제**(영구 저장하지 않음) |
| 검증 | `state` 쿠키 + DB state, PKCE S256, 서버측 code 교환, `email_verified` 요구 |
| 계정 탈취 방지 | 이메일만으로 기존 계정에 자동 연결하지 않는다(연결은 로그인 상태에서 명시적으로) |

## 2. 흐름

```
[브라우저] POST /api/auth/google/start {intent}   → { authorizationUrl }
           (state 는 HttpOnly 쿠키 om_oauth_state 에도 저장)
[브라우저] Google 인증 → GET /api/auth/google/callback?code&state
[서버]     state 쿠키·DB 검증 → code 교환(PKCE) → userinfo(sub, email_verified)
           → 1회용 티켓 생성 → 302 APP_ORIGIN/?oauth_ticket=…&oauth_intent=…
[브라우저] POST /api/auth/google/complete {ticket, username?, device{공개키}}
[서버]     티켓 소비 → 계정 생성 또는 기기 등록 → 세션 쿠키 발급
```

기기 키는 **브라우저에서만** 생성되므로, 콜백에서는 세션을 발급하지 않고 티켓만 넘긴다.
완료 요청이 기존 `/api/auth/register`·`/api/auth/login` 과 같은 의미론(공개키만 등록)을 갖는다.

## 3. 엔드포인트

| 메서드·경로 | 인증 | 설명 |
|---|---|---|
| `POST /api/auth/google/start` | 없음(레이트리밋) | `intent: signup \| login`. `authorizationUrl` 반환 |
| `POST /api/auth/google/start/link` | 세션 + CSRF | 로그인 상태에서 연결 시작 |
| `GET /api/auth/google/callback` | state 쿠키 | Google 콜백. 성공 시 SPA 로 302 |
| `POST /api/auth/google/complete` | 티켓 | 가입(`username`+`device`) 또는 로그인(`device`) 완료 |
| `POST /api/auth/google/complete/link` | 세션 + CSRF + 티켓 | 연결 완료(티켓의 `user_id` 와 세션 사용자가 같아야 함) |
| `POST /api/auth/google/unlink` | 세션 + CSRF + 비밀번호 | 연결 해제(비밀번호 없는 계정은 거부) |

`GET /api/auth/me` 가 `oauthEnabled`, `googleLinked`, `hasPassword` 를 함께 반환한다.

### 콜백 오류 코드(SPA 로 `oauth_error` 전달)

| 코드 | 의미 |
|---|---|
| `access_denied` | 사용자가 동의를 취소 |
| `invalid_request` | `code`/`state` 누락 |
| `state_mismatch` | 쿠키 state 불일치(로그인 CSRF 의심) |
| `state_expired` | state 만료 또는 재사용 |
| `provider_error` | 토큰 교환·userinfo 실패(PKCE 불일치 포함) |
| `email_unverified` | Google 이메일 미인증 |
| `not_linked` | 로그인 의도인데 연결된 계정이 없음 |
| `already_linked` | 이미 다른 사용자에게 연결된 Google 계정 |

## 4. 계정 연결·해제·삭제

- **연결**: 로그인 상태에서만 가능하며, 완료 시 `users.oauth_provider/oauth_subject` 를 채운다(부분 유니크 인덱스로 1:1 보장).
- **해제**: 비밀번호 확인 후 해제한다. **비밀번호가 없는 계정은 해제를 거부**한다(잠금 방지, `PASSWORD_REQUIRED`).
- **계정 삭제**: 비밀번호 계정은 기존과 동일(비밀번호 확인). **Google 전용 계정은 아이디 재입력**(`confirmUsername`)으로 확인하며, 삭제 시 `oauth_subject` 를 비워 같은 Google 계정으로 다시 가입할 수 있다.
- **decoy 프로필**: 지금은 비밀번호로 실제/decoy 를 구분한다. Google 로그인은 이 구분이 불가능하므로 decoy 는 **별도 Google 계정**이 필요하다(또는 decoy 는 비밀번호 로그인 전용으로 둔다).

## 5. 운영 설정

```dotenv
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URL=https://chat.example.com/api/auth/google/callback
APP_ORIGIN=https://chat.example.com
# 선택: 자체 IdP/테스트용 오버라이드
# GOOGLE_AUTHORIZE_URL= GOOGLE_TOKEN_URL= GOOGLE_USERINFO_URL=
```

1. Google Cloud Console → **OAuth 동의 화면**(외부, `openid email profile`) → **OAuth 클라이언트 ID(웹)** 생성
2. 승인된 리디렉션 URI 에 `GOOGLE_REDIRECT_URL` 과 **정확히 같은 값**을 등록
3. 위 4개 변수를 주입하고 재기동. 세 변수 중 일부만 설정하면 기동 시 오류로 알린다(부분 설정 금지).
4. 설정이 없으면 `oauthEnabled=false` 이고 `/api/auth/google/*` 는 `503 OAUTH_DISABLED` 를 반환한다.

## 6. 테스트

`test/api-google-oauth.test.ts` 가 **스텁 IdP**(토큰 교환·userinfo)를 띄워 13개 시나리오를 검증한다.
실제 Google 호출은 테스트에 포함하지 않는다(네트워크 비의존).

- 가입 → 세션 발급, DB 에 `password_hash = null`·`oauth_subject` 저장, 티켓 잔여 없음
- 연결된 계정 로그인(새 기기), 미연결 계정 로그인 거부, 중복 연결 가입 거부
- state 쿠키 불일치·만료, PKCE 불일치, 미인증 이메일 거부
- 기존 비밀번호 계정 연결 → 잘못된 비밀번호 해제 거부 → 정상 해제
- Google 전용 계정의 비밀번호 로그인 거부, 티켓 1회용, 다른 사용자 티켓 거부
- 아이디 확인 삭제 후 같은 Google 계정 재가입

## 7. 한계(다음 단계)

- **클라이언트 UI 미구현**: 로그인/가입 화면 버튼, 아이디 선택 단계, 콜백 처리, 기기 설정 화면 연결/해제 버튼 — 2단계.
- OAuth 전용 계정은 **복구 암호 백업을 따로 설정**해야 기기 분실 시 이력을 복구할 수 있다(현재는 비밀번호 계정과 동일하게 복구 암호 사용).
- 이메일은 저장하지 않으므로 "Google 이메일 표시"·"이메일로 계정 찾기" 기능은 없다.
- 계정 삭제 확인이 비밀번호 계정보다 약하다(아이디 재입력). 세션+CSRF 는 그대로 요구한다.

