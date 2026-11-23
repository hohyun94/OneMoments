# 기기·마이크 감지

접속 기기의 플랫폼을 **best-effort 메타데이터**로 저장하고, 마이크 사용 가능 여부를
사용자 요청 시점에 확인한다. 둘 다 권한·보안 판단의 근거로 쓰지 않는다.

## 1. 기기 플랫폼

### 저장값
`devices.platform` — `ios | android | mobile | desktop | unknown` (기본 `unknown`)

- 기기 등록(가입·새 기기 로그인·기기 추가) 시 클라이언트가 신고한다.
- 서버는 enum 만 검증하고, **UA를 직접 파싱해 권한을 결정하지 않는다.**
- 기기 목록(`GET /api/devices`, `/api/auth/me`)에 표시된다.
- 마이그레이션: `0025_silent_swarm.sql`

### 감지 규칙 (`client/src/lib/device.ts`)
1. iPadOS 13+ 의 데스크톱 UA(`MacIntel` + `maxTouchPoints > 1`) → `ios`
2. UA에 `iPhone|iPad|iPod` → `ios`
3. UA에 `Android` → `android`
4. Chromium `navigator.userAgentData.mobile === true` → `mobile`
5. UA/플랫폼이 Windows·Macintosh·Linux·CrOS → `desktop`
6. 그 외 → `unknown`

### 한계
- UA·UA-CH·`navigator.platform`은 **클라이언트가 위조할 수 있다.**
- Android 태블릿은 `android`, iPad는 `ios`로 잡히며 “모바일/태블릿” 구분은 하지 않는다.
- Firefox/Safari에는 UA-CH가 없어 UA 문자열에 의존한다.
- 플랫폼 값으로 기능을 하드 게이팅하지 않는다. 음성·통화는 **기능 지원과 권한 결과**로 판단한다.

## 2. 마이크 확인

### 유틸 (`client/src/lib/microphone.ts`)
- `microphoneCapability({ isSecureContext, hasGetUserMedia })`
  - `insecure` — HTTPS/localhost 아님
  - `unsupported` — `getUserMedia` 없음
  - `ready`
- `checkMicrophone()`
  1. 위 환경 확인
  2. `navigator.mediaDevices.getUserMedia({ audio: true })` 호출
  3. 성공 시 모든 트랙을 즉시 `stop()` 하고 `available`
  4. 실패 원인을 `denied | not-found | busy | unsupported | error` 로 분류
- `queryMicrophonePermission()` — Permissions API 지원 브라우저에서 `granted|denied|prompt` 조회
- `microphoneStatusLabel()` — UI 문구

### UI
`/devices` → **마이크 확인** 카드
- 사용자가 `마이크 확인` 버튼을 눌렀을 때만 권한을 요청한다(자동 요청 금지).
- 결과 문구와 권한 차단/HTTPS 안내를 표시한다.
- 확인 결과는 **서버로 전송하거나 저장하지 않는다.**

## 3. 프라이버시·보안

- 마이크 보유 여부·권한 상태는 fingerprinting/프라이버시 문제가 되므로 DB에 저장하지 않는다.
- 기기 플랫폼은 표시·통계 보조 정보일 뿐이며, 인증·권한·요금 정책에 사용하지 않는다.
- `getUserMedia`는 보안 컨텍스트(HTTPS/localhost)에서만 동작한다.
- 권한은 브라우저 사이트 설정에서 언제든 변경될 수 있으므로 “한 번 확인 = 영구 보장”이 아니다.
- 마이크가 있어도 OS 정책·다른 앱 점유·권한 거부로 사용하지 못할 수 있다.

## 4. 테스트

- 클라이언트 `client/src/lib/device.test.ts` — iPhone/Android/iPadOS 데스크톱 UA/UA-CH/데스크톱/unknown
- 클라이언트 `client/src/lib/microphone.test.ts` — 보안 컨텍스트·미지원·오류 분류·라벨
- 서버 `test/api-platform.test.ts` — 플랫폼 저장/기본값/기기 추가/enum 검증
- E2E는 환경에 Chrome이 없어 미실행

## 5. 후속: 음성 메시지·통화

- 음성 메시지: `getUserMedia` → `MediaRecorder` → 파일별 AES-GCM 암호화 후 기존 첨부 경로 사용
- 통화: `RTCPeerConnection` + WS 시그널링. 모바일 백그라운드·PWA 제약은 별도 결정 필요
- 마이크 권한은 통화/녹음 시작 시점에 요청하고, 결과를 서버에 저장하지 않는다.
