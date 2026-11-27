# 일기장(공유 다이어리) 설계

24시간 만료되는 Moments 대신, **만료 없이 보관되고 지정한 대상에게만 공개되는** 일기장.
대상이 바뀌면 **키 세대를 올려(정책 B)** 새 대상자가 과거 글을 볼 수 없게 한다.

## 1. 모델

| 테이블 | 역할 |
|---|---|
| `diaries` | 일기장. `ownerUserId`, `label`(평문 40자, 프로필 상태처럼 메타데이터), **`keyEpoch`** |
| `diary_audience` | 공유 대상. PK(diaryId,userId), `joinedEpoch`(합류 시점 세대) |
| `diary_entries` | 글 1건. `ciphertext`/`nonce`/`signature`, `keyEpoch`, `clientEntryId`(멱등), 작성자 기기·서명키 스냅샷 |
| `diary_entry_keys` | 글 1건의 **수신 기기별 봉투**(메시지와 같은 v1/v2 형식: wrapNonce·version 포함) |

제목·본문은 모두 `ciphertext` 안에 넣는다(서버는 평문·키를 모른다). 대상·작성자·시각·크기만 메타데이터.

## 2. 키 회전 (정책 B)

```
대상 변경(추가/제거) → diaries.keyEpoch += 1
   ├─ 새 대상자: diary_audience.joinedEpoch = 새 세대
   ├─ 제거된 대상자: audience 행 삭제 → 목록·조회 자체가 403
   └─ 이후 글은 새 세대 키로 암호화되고, 그 세대 봉투만 배포된다
```

- 과거 글은 이전 세대 봉투를 가진 사람만 열 수 있다 → **새 대상자는 과거 글을 볼 수 없다**(구조적 보장).
- 제거된 사람은 이미 받은 암호문을 되돌릴 수는 없지만, **서버 접근이 즉시 차단**된다.
- 조회는 `diary_entry_keys` 에 **내 활성 기기 봉투가 있는 글**만 반환한다(이중 안전장치).

## 3. API 계획

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/diaries` | 내 일기장 목록(소유 + 대상) |
| POST | `/api/diaries` | 생성 `{ label?, audienceUserIds[] }` |
| PUT | `/api/diaries/:diaryId/audience` | 대상 변경(소유자만) → 새 `keyEpoch` 반환 |
| GET | `/api/diaries/:diaryId/entries?before=&limit=` | 글 목록(내 봉투가 있는 것만) |
| POST | `/api/diaries/:diaryId/entries` | 글 작성 `{ clientEntryId, ciphertext, nonce, signature, keys[] }` |
| GET | `/api/diaries/entries/:entryId` | 글 1건(내 기기 봉투 포함) |
| PATCH | `/api/diaries/entries/:entryId` | 수정(작성자만, 같은 세대 유지) |
| DELETE | `/api/diaries/entries/:entryId` | 삭제(작성자 또는 일기장 소유자) |

## 4. 불변식

- 서버는 복호화하지 않는다. `normalizeMessagePayload` 로 봉투 길이·버전·서명을 검증한다.
- 봉투 대상은 **현재 대상자(소유자 포함)의 활성 기기**로 제한하고, 대상자마다 최소 1개 봉투를 요구한다.
- 작성자 본인 기기 봉투가 반드시 포함되어야 한다(`MISSING_AUTHOR_ENVELOPE`).
- v2 봉투의 원타임 프리키는 저장 시 1회 소비한다(불변식 24).
- 푸시 알림을 붙일 때도 내용은 넣지 않는다(불변식 17). 검색은 클라이언트 IndexedDB 에서만.

## 5. UI 계획

- 목록: 내 일기장 카드(이름·대상 수·최근 글 시각) + `새 일기장`
- 상세: 날짜 그룹 타임라인, `글쓰기`(제목+본문 암호화), 작성자 표시, 수정/삭제
- 대상 관리 시트: 연락처에서 선택 → 저장 시 **키 회전 안내**(“이전 글은 새로 추가된 사람에게 보이지 않습니다”)
- 사진 첨부는 2단계(업로드 → 암호문 저장, 기존 첨부 파이프라인 재사용)

## 6. 진행 상태

- [x] 스키마·마이그레이션(`0038_deep_klaw.sql`)
- [x] 서비스(`src/services/diaries.ts`): 목록/상세/생성/대상 변경/글 목록·조회·작성·삭제
- [x] 라우트(`src/routes/diaries.ts`) + 마운트
- [ ] 클라이언트(목록·작성·읽기·대상 관리) — 다음 단계
- [ ] 사진 첨부(`uploadAttachment` 재사용)
- [ ] 테스트·문서 마무리
