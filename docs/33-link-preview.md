# 링크 미리보기 (Open Graph)

## 1. 왜 서버가 가져오는가

브라우저에서 `fetch(url)` 로 OG 메타데이터를 읽으려면 대상 사이트가 CORS 를 허용해야 하는데, 대부분 허용하지 않는다.
그래서 **서버가 대신 가져오되**, 결과를 **저장하지 않고** 클라이언트가 **메시지 암호문 안에 넣어** 전송한다.

| 항목 | 결정 |
|---|---|
| 메타데이터 저장 | **서버 저장 없음** — 발신 클라이언트가 평문 JSON 을 암호화해 메시지로 전송 |
| 수집 항목 | `og:title`, `og:description`, `og:site_name` (+`<title>`, `description` 폴백) |
| 수집하지 않는 것 | **이미지·파비콘**(상대 IP 노출/CSP), 스크립트, 쿠키 |
| 트리거 | 사용자가 입력창의 **"링크 미리보기"** 버튼을 누를 때만(자동 수집 없음) |
| 끄기 | `LINK_PREVIEW_ENABLED=false` |

## 2. 메시지 형식

```
onemoments:link:v1:<base64(JSON)>
JSON = { text, preview: { url, title, description, siteName } }
```

- `text` 는 원문(링크 포함)이며 그대로 본문으로 렌더링된다.
- 미리보기 없이 보내면 기존과 동일한 평문이다(하위 호환).
- 위치 공유(`onemoments:location:v1:`)·첨부 페이로드와 같은 "암호문 안 페이로드" 패턴을 따른다.

## 3. SSRF·남용 방어

`src/services/linkPreview.ts` 에서 강제한다.

| 방어 | 내용 |
|---|---|
| 스킴 | `http:`, `https:` 만. `file:`, `javascript:` 등 거부 |
| 자격증명 | `https://user:pass@host` 형태 거부 |
| 사설망 | DNS 해석 후 **사설/루프백/링크로컬/멀티캐스트**면 거부(`isPrivateAddress`) |
| 리다이렉트 | 최대 2회, **매 홉마다** 같은 검사 |
| 크기·시간 | 본문 256KB 상한, 4초 타임아웃 |
| 형식 | `text/html` 만. 그 외/오류/빈 메타데이터는 `null` |
| 인증 | 세션 + CSRF 불필요(GET) + **사용자당 분당 20회** 레이트리밋 |
| 저장 | 결과를 DB·로그에 남기지 않는다 |

**남는 위험(문서화)**: DNS 리바인딩(검사 시점과 연결 시점의 IP 불일치)까지 완전히 막지는 않는다.
완전 차단이 필요하면 아웃바운드 프록시/고정 리졸버를 두고 `undici` 커스텀 lookup 을 써야 한다.

## 4. API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/link-preview?url=` | `{ preview: {url,title,description,siteName} \| null }`, `Cache-Control: private, no-store` |

## 5. 클라이언트

- 입력창: 본문에 `http(s)` URL 이 있으면 **링크 미리보기** 버튼 노출 → 결과 카드(제목·사이트) 표시/제거.
- 본문에서 URL 이 사라지면 카드도 자동 제거.
- 말풍선: 본문 아래에 카드(사이트·제목·요약)를 렌더링하고 `rel="noopener noreferrer nofollow"` 로 새 탭에서 연다.
- 답장 인용은 `text` 만 사용한다(카드 메타데이터는 인용하지 않음).

## 6. 검증

| 계층 | 내용 |
|---|---|
| 서버 단위 | 사설 IP 판별(IPv4/IPv6/매핑), OG/폴백 파싱·엔티티 디코딩, 127.0.0.1 기본 차단, 리다이렉트 1회 추적, 비HTML·404·위험 스킴 거부 |
| 클라이언트 단위 | 페이로드 왕복, 위험 스킴 거부, URL 추출·말미 구두점 제거 |
