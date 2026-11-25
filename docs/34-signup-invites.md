# 가입 정책 (초대 코드)

## 1. 모드

| `SIGNUP_MODE` | 동작 |
|---|---|
| `open` (기본) | 누구나 가입(기존과 동일) |
| `invite` | **관리자가 발급한 초대 코드**가 있어야 가입. 코드가 없으면 400 `INVITE_REQUIRED`, 유효하지 않으면 403 |
| `closed` | 가입 전체 차단(403). 클라이언트는 가입 탭을 숨긴다 |

`/api/auth/config` 가 `signupMode` 를 내려주므로, 클라이언트는 로그인 전에도 정책을 안다.

## 2. 초대 코드 설계

| 항목 | 결정 |
|---|---|
| 형식 | 12자, `A-Z`+`2-9`(0/O/1/I 제외). 입력은 공백·하이픈 제거 + 대문자 정규화 |
| 저장 | `signup_invites`(마이그레이션 0035). 코드는 **유니크 인덱스** |
| 통제 | `max_uses`(1~100), `expires_at`(무기한 가능), `revoked_at`(폐기) |
| 소모 | `used_count < max_uses` 조건부 **원자 UPDATE** — 계정 생성과 **같은 트랜잭션**에서 처리해 실패 시 롤백 |
| 발급/폐기 | 관리자 콘솔 "가입 초대" 탭, `auth_events` 에 `admin_signup_invite_created/revoked` 감사 기록 |

## 3. API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/admin/signup-invites` | 발급 목록 + 현재 `signupMode` (관리자 전용) |
| POST | `/api/admin/signup-invites` | `{ maxUses?: 1~100, expiresInDays?: 1~365 \| null }` → 코드 발급 |
| DELETE | `/api/admin/signup-invites/:inviteId` | 폐기 |
| POST | `/api/auth/register` | `inviteCode`(invite 모드에서 필수) |

오류: `INVITE_REQUIRED`(400), `INVITE_INVALID`/403(없음·폐기·만료·소진), `SIGNUP_CLOSED`/403.

## 4. 클라이언트

- 가입 폼에 **초대 코드** 입력(invite 모드에서만 표시, 필수).
- `closed` 모드에서는 가입 탭을 숨긴다.
- **Google 신규 가입은 invite/closed 모드에서 차단**한다(코드 우회 방지). Google **로그인**은 그대로 가능.

## 5. 운영

- 최초 관리자 계정은 **이미 존재해야** 한다(`ADMIN_USERNAMES` allowlist 기준). 초대제로 바꾸기 전에 관리자 계정이 있는지 확인한다.
- `SIGNUP_MODE=invite` 로 바꾼 뒤 재배포 → 관리자 콘솔 → "가입 초대" 탭에서 코드 발급 → 전달.
- 코드는 대화·메일 등으로 직접 전달한다(서버는 코드만 보관, 사용자에게 자동 발송하지 않음).

## 6. 한계

- 코드를 받은 사람이 재공유하면 통제할 수 없다 → `max_uses`·만료를 짧게 두고 주기적으로 폐기한다.
- 초대 코드에는 **발급 대상(특정 사용자) 개념이 없다**(누구나 사용 가능한 공용 코드).
- Google 가입을 코드와 함께 쓰려면 OAuth state 에 코드를 실어 보내는 추가 설계가 필요하다(현재는 차단).
- 기존 사용자·관리자 계정에는 영향이 없다.
