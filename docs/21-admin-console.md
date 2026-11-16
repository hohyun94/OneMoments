# 관리자 콘솔

`ADMIN_USERNAMES` allowlist 에 등록된 계정만 사용할 수 있는 **메타데이터 운영 화면**이다.
E2E 불변식은 그대로 유지된다: 관리자도 **메시지를 복호화할 수 없고**, 키·세션 토큰·비밀번호 해시를 볼 수 없다.

## 1. 활성화

```bash
ADMIN_USERNAMES=alice,bob   # 쉼표 구분, 소문자 username
```

- 비어 있으면 `/api/admin/*` 는 항상 403이고 `/admin` 메뉴도 표시되지 않는다.
- allowlist 는 DB 역할이 아니라 환경변수이므로 API 로 권한을 얻거나 넓힐 수 없다.
- 관리자도 일반 사용자와 같은 세션·CSRF·무활동 5분 자동 로그아웃 정책을 따른다.

## 2. 화면

| 탭 | 내용 |
|---|---|
| 개요 | 사용자(전체/삭제), 활성·폐기 기기, 1:1/그룹 대화, 메시지 수, 첨부 암호문 바이트, 활성 세션, 푸시 구독, decoy 수 |
| 사용자 | username 부분 검색(커서 페이지네이션·"더 보기"), 기기·세션 수, 상세(기기/세션 목록·대화/메시지/첨부 수), 세션 강제 종료 |
| 기기 | 활성/폐기/전체 필터, 소유자 username 부분 검색, 기기 이름·등록·마지막 활동 시각, 커서 페이지네이션("더 보기"), 기기별 세션 조회·전체 종료(활성 세션 수 표시), 활성 기기 폐기(세션·푸시 구독 정리, 감사 로그) |
| Decoy | decoy 목록·생성·비밀번호 교체·비활성화/활성화 |
| 감사 로그 | 관리자 조치 최근 100건 |

관리자 메뉴는 `GET /api/auth/me` 의 `user.isAdmin` 이 true 일 때만 렌더한다.

## 3. API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/admin/overview` | 서버 집계(메타데이터) |
| GET | `/api/admin/users?query=&cursor=&limit=` | username 부분 일치 + 키셋 페이지네이션 |
| GET | `/api/admin/users/:userId` | 사용자 상세(기기·세션·카운트) |
| GET | `/api/admin/devices?status=&query=&cursor=&limit=` | 기기 목록(기본 `status=active`, `active`/`revoked`/`all`) |
| POST | `/api/admin/devices/:deviceId/revoke` | 기기 폐기 + 세션·푸시 구독 삭제 + 감사 로그(이미 폐기면 `revoked: false`) |
| GET | `/api/admin/devices/:deviceId/sessions` | 기기 상세 + 세션 목록(토큰 해시 제외, 최근 100건) |
| POST | `/api/admin/devices/:deviceId/revoke-sessions` | 기기 세션 전체 종료 + 푸시 구독 삭제 + 감사 로그(기기는 유지) |
| POST | `/api/admin/users/:userId/revoke-sessions` | 세션 전체 삭제 + 푸시 구독 삭제 + 감사 로그 |
| GET | `/api/admin/audit` | 감사 로그 최근 100건 |
| GET | `/api/admin/decoy` | decoy 프로필 목록 |
| POST | `/api/admin/decoy` | `{ alias, handle?, password }` |
| POST | `/api/admin/decoy/:profileId/password` | `{ password }` 회전 |
| POST | `/api/admin/decoy/:profileId/disabled` | `{ disabled }` |

- 모든 경로는 `requireSession` + `requireAdmin` 을 통과한다.
- 상태 변경은 `x-csrf-token` 이 필요하다.
- 응답에는 `passwordHash`, `tokenHash`, 메시지 암호문/평문, 기기 개인키가 포함되지 않는다.

## 4. 감사 로그

`admin_audit_logs` 테이블에 한 줄씩 남긴다.

| 필드 | 내용 |
|---|---|
| `admin_username` | 조치한 관리자 username 스냅샷 |
| `action` | `user.sessions.revoked`, `device.revoked`, `device.sessions.revoked`, `decoy.created`, `decoy.password.rotated`, `decoy.disabled`, `decoy.enabled` |
| `target_username` | 대상 계정/decoy 핸들 |
| `detail` | 작업 메타데이터(예: 종료한 세션 수). 메시지 내용 금지 |

감사 로그에는 비밀번호·토큰·키를 절대 넣지 않는다.

## 5. 제한

- 관리자도 참여하지 않은 대화의 참여자·메시지·첨부를 조회할 수 없다.
- 계정 익명화 삭제는 사용자 본인 비밀번호 확인 흐름만 지원한다(관리자 강제 삭제 없음).
- decoy 관리는 CLI(`scripts/decoy-admin.mjs`)와 관리자 콘솔이 같은 테이블·규칙을 사용한다.
- allowlist 변경은 재배포/재기동이 필요하다.
- 세션 강제 종료는 기기·키를 폐기하지 않는다. 기기 폐기는 사용자 기기 관리 화면에서 한다.

## 6. 검증

```bash
pnpm test test/api-admin.test.ts
```

- 비관리자 403, 익명 401
- 개요·상세 응답에 `passwordHash`/`tokenHash` 부재
- CSRF 없는 세션 종료 403, 성공 시 대상 세션 무효 + 감사 로그 기록
- decoy 생성/회전/비활성화가 로그인에 즉시 반영되고 응답에 비밀번호 원문 부재
