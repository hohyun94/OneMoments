# 프로필 아바타 (공개 프로필 이미지)

## 1. 결정

| 항목 | 선택 | 이유 |
|---|---|---|
| 암호화 | **하지 않음(공개 메타데이터)** | 상태 메시지와 같은 "공개 프로필"이다. 대화 내용·키와 무관하며, 공개 범위를 문서·UI 에 명시한다 |
| 저장 | `users.avatar_mime` / `avatar_data`(base64) | 별도 오브젝트 스토리지 없이 마이그레이션 1개로 끝난다. 아바타는 128px·수십 KB 수준 |
| 크기 | 원본 바이트 **64KB**, 클라이언트 전송 전 **128px JPEG(품질 0.85)** | 전역 JSON 본문 한도(`MAX_CIPHERTEXT_BYTES` 기반, 기본 160KB) 안에 안전하게 들어간다 |
| 형식 | `image/png`, `image/jpeg`, `image/webp` | SVG·GIF 는 XSS/애니메이션 위험으로 제외 |
| 접근 | **로그인 사용자면 조회 가능** | 상태 메시지와 동일한 공개 범위. 비로그인은 401 |
| 캐시 | `private, max-age=300` + ETag(`avatar_updated_at`) | 프로필 변경 시 즉시 갱신, 불필요한 재전송 방지 |

## 2. API

| 메서드 | 경로 | 설명 |
|---|---|---|
| `PUT` | `/api/auth/profile/avatar` | `{ mime, data(base64) }` 업로드. 세션+CSRF. 응답 `{ user }`(갱신된 `avatarUpdatedAt`) |
| `DELETE` | `/api/auth/profile/avatar` | 아바타 삭제(없어도 200) |
| `GET` | `/api/users/:userId/avatar` | 이미지 바이트. 없으면 404, 삭제된 계정도 404. `If-None-Match` 지원 |

`avatarUpdatedAt` 은 `PublicUser`, `PeerUser`, `ContactView`, 사용자 검색 결과에 실린다.
클라이언트는 `avatarUrl(userId, avatarUpdatedAt)` 로 `?v=` 를 붙여 브라우저 캐시를 무효화한다.

## 3. 클라이언트

- `lib/avatar.ts`: 형식·크기 검증, URL·이니셜, `fileToAvatarPayload()`(canvas 로 정사각 128px 크롭·JPEG 변환).
- `ui.tsx` 의 `Avatar` 컴포넌트가 `userId`+`avatarUpdatedAt` 을 받으면 이미지, 없거나 로드 실패 시 이니셜을 표시한다.
- 적용 위치: 대화 목록, 대화 헤더(1:1), 연락처 목록, 내 프로필 카드.
- 프로필 카드(`/contacts`): 사진 선택(파일 입력) / 사진 삭제, 공개 범위 안내.

## 4. 프라이버시·한계

- 아바타와 상태 메시지는 **서버가 평문으로 보관**한다(공개 프로필). 대화 내용의 E2E 원칙과 구분된다.
- 계정 익명화 삭제 시 아바타도 함께 삭제한다(`deleteAccount`).
- 아바타를 아는 사람은 프로필 사진 자체를 저장·재배포할 수 있다(공개 이미지의 일반적 한계).
- 이미지 메타데이터(EXIF)는 canvas 재인코딩 과정에서 제거된다.
- 그룹 대화 목록은 그룹 이름/이니셜을 쓰며, 그룹 아바타는 범위 밖이다.

## 5. 검증

| 계층 | 내용 |
|---|---|
| 서버 | 업로드→다른 사용자 조회(바이트 일치·ETag·304), 형식/크기/base64 거부, 삭제 후 404, 비로그인 401 |
| 클라이언트 | 파일 검증, URL 캐시 무효화, 이니셜 폴백 |
