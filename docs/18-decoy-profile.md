# Decoy 프로필 (배포 관리자 전용)

실제 로그인 ID와 비밀번호는 그대로 두고, **관리자가 설정한 별도 decoy 비밀번호**로 로그인하면
실제 프로필이 아닌 **격리된 decoy 프로필**로 들어간다. 일반 사용자 화면에는 decoy의 존재를 표시하지 않는다.

## 1. 원칙

- decoy 자격증명은 **배포 관리자 CLI 또는 관리자 콘솔(`ADMIN_USERNAMES` allowlist)** 로만 생성·회전·비활성화한다.
- 일반 사용자 API/UI에는 decoy 목록·설정·존재 표시가 없다.
- decoy 로그인은 **decoy 사용자 세션**만 발급한다. 실제 사용자 토큰은 발급하지 않는다.
- 실제/decoy 프로필은 user·device·E2E 키·대화·푸시가 분리된다.
- 관리자는 decoy 비밀번호 원문을 DB에 저장하지 않는다(해시만).
- 관리자는 실제 메시지를 복호화할 수 없다.

## 2. 준비

배포 서버의 app 컨테이너에서 실행한다.

```bash
# decoy 프로필 + 비밀번호 생성 (비밀번호는 환경변수로 전달)
DECOY_PASSWORD='<long-decoy-password>' \
  node scripts/decoy-admin.mjs create \
  --alias <real-login-id> \
  --handle <decoy-public-handle>
```

- `--alias`: 사용자가 로그인할 실제 ID
- `--handle`: decoy 화면에 보일 별도 공개 핸들(선택, 기본 `decoy_xxxxxxxx`)
- `DECOY_PASSWORD`: 10자 이상, 실제 비밀번호와 달라야 함
- 명령 출력에는 비밀번호가 포함되지 않는다.

### 회전·비활성화

```bash
# decoy 비밀번호 교체
DECOY_PASSWORD='<new-password>' node scripts/decoy-admin.mjs rotate --alias <id>

# decoy 로그인 차단 / 해제
node scripts/decoy-admin.mjs disable --alias <id>
node scripts/decoy-admin.mjs enable --alias <id>
```

### 관리자 콘솔에서 관리

`ADMIN_USERNAMES` 에 등록된 계정으로 로그인하면 사이드바의 **관리자 콘솔 → Decoy** 탭에서 같은 작업을 할 수 있다.

- decoy 프로필 목록·활성/비활성 상태 확인
- 실제 로그인 ID + 선택 핸들 + decoy 비밀번호로 생성
- 비밀번호 교체(기존 decoy 비밀번호 즉시 무효), 비활성화/활성화
- 서버는 비밀번호 해시만 저장하고 생성·교체 응답에 원문을 포함하지 않는다
- `ADMIN_USERNAMES` 가 비어 있으면 `/admin` 메뉴와 `/api/admin/*` 가 모두 비활성화된다

권한 모델·감사 로그·API: [`21-admin-console.md`](21-admin-console.md)

## 3. 로그인 동작

```text
아이디: <real-login-id>
  + 실제 비밀번호   → 실제 프로필
  + decoy 비밀번호  → decoy 프로필
```

- 로그인 화면에는 decoy 안내가 없다.
- 실패 응답은 실제/decoy 모두 동일한 `Invalid username or password`.
- 같은 브라우저에서 두 프로필의 identity를 각각 저장하며, 비밀번호에 해당하는 기기에서만 로그인된다.
- decoy 첫 로그인 시 decoy 전용 기기 키가 생성·등록된다.
- decoy 로그인 시 브라우저 푸시 구독을 해제해 실제 프로필 알림이 decoy 화면에 노출되지 않게 한다.

## 4. 분리 범위

| 항목 | 분리 |
|---|---|
| 사용자/세션 | 별도 user, 별도 session |
| 기기 | 별도 device row |
| E2E 키 | 별도 IK/SPK/OPK, DR/sender key |
| 대화/메시지 | 별도 conversation |
| 알림 | decoy 로그인 시 실제 푸시 구독 해제 |
| 백업 | 프로필별 identity/backup |

## 5. 한계

- **배포 관리자는 decoy 프로필과 실제 프로필의 연결 관계를 알 수 있다.** 서버/DB 소유자에게 이 존재를 숨기는 것은 불가능하다.
- **관리자는 decoy 비밀번호를 알게 된다.** 요구사항상 관리자가 설정·전달하는 모델이다.
- 실제 데이터는 삭제되지 않고 decoy 세션에서 접근이 차단될 뿐이다.
- 브라우저 개발자도구·기기 포렌식까지 대응하려면 프로필별 로컬 키 암호화가 추가로 필요하다.
- decoy 프로필의 대화는 사용자가 미리 로그인해 채워 두어야 자연스럽다. 관리자 CLI는 프로필만 생성한다.
- 실제 프로필과 decoy 프로필은 같은 IndexedDB에 저장되지만, 기기 ID·키·세션은 서로 다르다.

## 6. 검증

- 서버: 실제/decoy 비밀번호가 서로 다른 user로 인증, decoy 세션에서 실제 대화 404, 잘못된 비밀번호 401
- 관리자: `/api/admin/decoy` 생성·회전·비활성화가 decoy 로그인에 즉시 반영되고 응답에 비밀번호 원문이 없음(`test/api-admin.test.ts`)
- 브라우저: 실제 로그인 → 로그아웃 → decoy 로그인 → decoy 재로그인, decoy 화면에 실제 대화 미노출
