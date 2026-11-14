# 네이티브 앱 평가

현재 웹 PWA로 핵심 기능(Web Push 포함)이 동작한다. 네이티브 앱은 **아직 구현하지 않았고**, 아래 결정 게이트를 통과할 때 착수한다.

## 1. 목표

| 요구 | 웹 PWA | 네이티브 목표 |
|---|---|---|
| E2E 암호 | WebCrypto/noble | 동일 프로토콜, 네이티브 crypto |
| 키 보관 | IndexedDB | Keychain(iOS) / Keystore(Android) |
| 백그라운드 수신 | Web Push(iOS 제약) | APNs/FCM + 앱 복호화 |
| 오프라인 이력 | IndexedDB/SW | SQLite + 암호화 저장 |
| 알림 | Web Push | APNs/FCM, 대화별 음소거 동일 |
| 첨부 | 암호문 업로드 | 동일 서버 API |

서버 API·암호 봉투는 그대로 재사용한다. **서버는 계속 평문·키를 모른다.**

## 2. 후보

### A. React Native (bare, New Architecture)

- 장점: TypeScript 자산 공유, 기존 프로토콜/타입 재사용, Android/iOS 단일 코드
- 암호: `react-native-quick-crypto` + `@noble/curves`(Ed25519/X25519) 또는 libsodium 바인딩
  - WebCrypto API 차이를 추상화한 `CryptoBackend` 어댑터 필요
- 저장: `react-native-keychain`(IK/SPK private), SQLite(DR/sender key/history)
- 푸시: `@react-native-firebase/messaging`(FCM) + APNs, 서버는 기존 push 구독 테이블 확장
- 위험: WebCrypto와의 바이트 호환 검증, 백그라운드 제한, 앱 서명·배포

### B. Flutter

- 장점: UI 일관성, `cryptography`/libsodium, `flutter_secure_storage`
- 단점: TS 프로토콜 자산 재사용 불가, 암호 포팅·테스트 중복
- 위험: 두 구현의 프로토콜 드리프트

**권고: React Native(bare) + noble/libsodium.** 웹과 동일한 테스트 벡터(봉투/서명/KDF)를 공유할 수 있는 것을 1차 게이트로 둔다.

## 3. 필수 작업

1. **CryptoBackend 추상화**: 웹 WebCrypto/noble, RN quick-crypto/noble을 같은 인터페이스로
2. **프로토콜 벡터**: 웹에서 만든 v2/X3DH/sender-key 봉투를 RN에서 복호화(양방향)하는 CI 벡터
3. **키 보관**: IK/SPK private·DR/sender-key/history를 Keychain/Keystore + 암호화 SQLite로
4. **백업/복구**: 기존 PBKDF2 백업 포맷 호환, 네이티브 secure storage에서 내보내기
5. **푸시 토큰**: FCM/APNs 토큰을 기존 `push_subscriptions`에 저장, SSRF 가드 유지
6. **WS/재연결**: 앱 백그라운드/포그라운드, 네트워크 복구 시 이력 동기화
7. **첨부**: 스트리밍 업로드/다운로드, 암호문만 저장
8. **안전번호/기기 관리 UI** 동등성

## 4. 결정 게이트

- [ ] 웹↔RN 암호 벡터 100% 상호운용
- [ ] 키가 평문 파일/SQLite에 남지 않음(보안 리뷰)
- [ ] APNs/FCM 실기기 수신, 음소거/읽음 동작
- [ ] 백업 복구 후 기존 그룹/1:1 이력 복호화
- [ ] 앱스토어 개인정보·암호화 수출 신고 요건 정리

## 5. 비목표(현재)

- 웹 기능 대체가 아니라 **동시 지원**
- Sender Keys/DR 프로토콜 변경 없음
- 서버의 평문 접근·키 에스크로 없음

네이티브 착수 전까지 웹 PWA가 기준 구현이며, 서버·문서는 네이티브 클라이언트를 전제로 확장 가능하게 유지한다.
