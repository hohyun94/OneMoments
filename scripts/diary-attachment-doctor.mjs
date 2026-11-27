import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import pg from "pg";

/**
 * 일기 첨부 무결성·사용량 점검.
 *
 * - 행은 있지만 저장소에 블롭이 없는 경우(유실)를 찾아 리포트한다.
 * - 블롭은 있는데 행이 없는 경우(고아 파일)도 함께 센다.
 * - `--delete-missing-rows` 를 주면 유실 행을 정리한다(파일은 이미 없다).
 * - `--usage` 를 주면 일기장별 사용량 상위 목록을 보여 준다.
 *
 * 로컬 저장소(`ATTACHMENT_STORAGE=local`)만 파일을 직접 확인한다.
 * S3 는 목록 조회 비용이 커서 이 스크립트에서 확인하지 않는다(행 합계만 출력).
 */
const args = new Set(process.argv.slice(2));
const deleteMissing = args.has("--delete-missing-rows");
const showUsage = args.has("--usage");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL 이 필요합니다. `pnpm diary:attachment-doctor`(env 파일 포함)로 실행하세요.");
  process.exit(1);
}
const storageKind = (process.env.ATTACHMENT_STORAGE ?? "local").toLowerCase();
const directory = path.resolve(process.env.ATTACHMENT_DIR ?? "./data/attachments");
const filePath = (id) => path.join(directory, `${id}.bin`);

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const rows = await pool.query(
    `select id, size, entry_id, uploader_user_id, created_at from diary_attachments order by created_at`,
  );
  /** @type {Set<string>} */
  const known = new Set(rows.rows.map((row) => row.id));
  let totalBytes = 0;
  for (const row of rows.rows) totalBytes += Number(row.size);

  const orphans = [];
  if (storageKind === "local") {
    for (const row of rows.rows) {
      try {
        await stat(filePath(row.id));
      } catch {
        orphans.push(row);
      }
    }
  }

  let strayFiles = 0;
  if (storageKind === "local") {
    try {
      const files = await readdir(directory);
      for (const name of files) {
        if (!name.endsWith(".bin")) continue;
        const id = name.slice(0, -4);
        if (!known.has(id)) strayFiles += 1;
      }
    } catch {
      console.warn(`저장소 디렉터리를 읽지 못했습니다: ${directory}`);
    }
  }

  console.log("── 일기 첨부 점검 ─────────────────────────────");
  console.log(`저장소      : ${storageKind}${storageKind === "local" ? ` (${directory})` : ""}`);
  console.log(`행 수       : ${rows.rows.length}`);
  console.log(`암호문 합계 : ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`유실 블롭   : ${orphans.length}건 (행은 있는데 파일 없음)`);
  console.log(`고아 파일   : ${strayFiles}건 (행 없는 .bin 파일)`);
  if (orphans.length > 0) {
    for (const row of orphans.slice(0, 20)) {
      console.log(`  - ${row.id} (entry ${row.entry_id ?? "미연결"})`);
    }
    if (orphans.length > 20) console.log(`  … 외 ${orphans.length - 20}건`);
  }

  if (showUsage) {
    const usage = await pool.query(
      `select e.diary_id,
              count(*)::int as files,
              sum(a.size)::bigint as bytes
         from diary_attachments a
         join diary_entries e on e.id = a.entry_id
        group by e.diary_id
        order by bytes desc
        limit 10`,
    );
    console.log("── 일기장별 사용량 상위 10 ────────────────────");
    for (const row of usage.rows) {
      const mb = (Number(row.bytes) / 1024 / 1024).toFixed(2);
      console.log(`  ${row.diary_id}  ${row.files}개  ${mb} MB`);
    }
    const unattached = rows.rows.filter((row) => row.entry_id === null).length;
    console.log(`미연결(업로드만) 첨부: ${unattached}건 — 24시간 뒤 자동 정리 대상`);
  }

  if (deleteMissing && orphans.length > 0) {
    const ids = orphans.map((row) => row.id);
    await pool.query(`delete from diary_attachments where id = any($1::uuid[])`, [ids]);
    console.log(`유실 행 ${ids.length}건을 삭제했습니다.`);
  } else if (orphans.length > 0) {
    console.log("(정리하려면 --delete-missing-rows 를 붙여 다시 실행하세요)");
  }
} finally {
  await pool.end();
}
