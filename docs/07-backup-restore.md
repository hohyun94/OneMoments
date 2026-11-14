# 백업·복구 가이드

DB에는 암호문만 저장되지만 **메타데이터(누가·언제·크기)** 는 민감하다. 백업 파일은 암호화해 오프사이트에 보관한다.

## 1. 전략

| 항목 | 권장 |
|---|---|
| 정기 백업 | 일일 `pg_dump`(custom format) + 오프사이트 보관 |
| 첨부 백업 | `ATTACHMENT_DIR`(compose `attachments` 볼륨)를 DB와 같은 주기로 함께 보관 |
| PITR | 관리형 DB면 PITR 활성화. 셀프호스팅이면 WAL 아카이빙 별도 구성 |
| 보관 | 일 7 · 주 4 · 월 6 (정책에 맞게) |
| 복구 목표 | RPO ≤ 24h(일일 백업), RTO ≤ 1h(연습 기준) |

## 2. 스크립트

`pg_dump`/`pg_restore`가 호스트에 있으면 그대로, 없으면 **PostgreSQL 컨테이너 안에서** 실행한다.

```bash
# 호스트에 pg_dump가 있는 경우
DATABASE_URL=postgres://... pnpm db:backup

# Docker 컨테이너에서 실행(Coolify compose의 postgres)
DATABASE_URL=postgres://... \
BACKUP_DOCKER_CONTAINER=postgres \
pnpm db:backup
```

- 산출물: `backups/onemoments-<timestamp>.dump` (`-Fc`, `--no-owner --no-privileges`)
- 복구:

```bash
DATABASE_URL=postgres://.../onemoments_restore_test \
RESTORE_CONFIRM=yes \
BACKUP_DOCKER_CONTAINER=postgres \
node scripts/restore.mjs backups/onemoments-....dump
```

> 복구는 `--clean --if-exists`로 기존 객체를 지우고 다시 만든다. **운영 DB에 바로 실행하지 말고**
> 스크래치/스테이징 DB에서 먼저 검증한다. `RESTORE_CONFIRM=yes`가 없으면 실행되지 않는다.

### 첨부 저장소

첨부 암호문은 PostgreSQL이 아니라 `ATTACHMENT_DIR`(운영 compose에서는 `attachments` 볼륨)에 있다.
**DB 백업만으로는 파일이 복구되지 않는다.** 같은 주기로 디렉터리/볼륨을 백업한다.

```bash
# 로컬/호스트 디렉터리
tar czf backups/onemoments-attachments-$(date +%F).tar.gz -C ./data/attachments .

# Docker 볼륨(compose 프로젝트 이름은 `docker volume ls`로 확인)
docker run --rm \
  -v <compose-project>_attachments:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine tar czf /backup/onemoments-attachments-$(date +%F).tar.gz -C /data .

# 복구
docker run --rm \
  -v <compose-project>_attachments:/data \
  -v "$PWD/backups:/backup" \
  alpine tar xzf /backup/onemoments-attachments-....tar.gz -C /data
```

- 일관성을 위해 백업 중에는 앱을 잠시 중지하거나 볼륨 스냅샷을 사용한다.
- 파일이 없어도 DB 메시지 이력은 복호화되지만, 해당 첨부 다운로드는 404가 된다.
- 업로드 후 메시지 전송 실패로 생긴 고아 블롭은 정리 정책이 아직 없다(용량 모니터링 필요).

## 3. Coolify 예약 작업

Coolify의 Scheduled Task(또는 외부 cron)로 아래를 등록한다.

```bash
docker exec onemoments-postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Fc > /backups/onemoments-$(date +%F).dump
```

compose의 `backup` 서비스 주석을 해제해 보관 정책을 자동화할 수도 있다(`prodrigestivill/postgres-backup-local`).

## 4. 복구 리허설 (검증 완료)

2026-11-14 로컬에서 아래 절차로 리허설을 수행했다.

1. 개발 DB 백업 → `backups/onemoments-....dump`
2. 스크래치 DB(`onemoments_restore_test`) 생성
3. `BACKUP_DOCKER_CONTAINER=onemoments-postgres`로 복구
4. 원본/복구 데이터 개수 비교 및 마이그레이션 테이블 확인

결과: `users/devices/messages` 개수와 `drizzle.__onemoments_migrations`(2건)가 원본과 일치.

### 복구 후 체크리스트

- [ ] `select count(*)`로 주요 테이블 개수 비교
- [ ] `drizzle.__onemoments_migrations` 최신 마이그레이션 확인
- [ ] 애플리케이션 `/readyz` 정상
- [ ] 테스트 계정으로 로그인·메시지 이력 복호화 확인
- [ ] 첨부 파일 다운로드·복호화 확인(`ATTACHMENT_DIR`/볼륨 복원 포함)
- [ ] 백업 파일 보관 위치/암호화 확인

## 5. 주의

- 복구한 DB에는 **평문이 없다**(암호문만). 복호화는 기기 키가 있는 클라이언트에서만 가능하다.
- 기기 키를 잃으면 서버 백업으로도 메시지를 복구할 수 없다(키 에스크로 없음).
- 백업/복구 명령은 `DATABASE_URL`에 비밀번호가 포함되므로 셸 기록·로그에 남기지 않는다.
- **첨부는 DB 밖에 있으므로 DB 덤프와 별도로 `attachments` 볼륨을 함께 백업**해야 한다.
