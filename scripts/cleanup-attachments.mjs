import { loadConfig } from "../dist/config.js";
import { createDb } from "../dist/db/client.js";
import {
  cleanupOrphanAttachments,
  createAttachmentStorage,
} from "../dist/services/attachments.js";

const config = loadConfig();
const { db, pool } = createDb(config);
const storage = createAttachmentStorage(config);
const olderThan = new Date(
  Date.now() - config.attachmentTtlDays * 24 * 60 * 60 * 1000,
);

let removed = 0;
try {
  for (let batch = 0; batch < 20; batch += 1) {
    const count = await cleanupOrphanAttachments(db, storage, olderThan);
    removed += count;
    if (count === 0) break;
  }
  console.log(
    JSON.stringify({
      level: "info",
      event: "attachments_cleanup",
      storage: config.attachmentStorage,
      ttlDays: config.attachmentTtlDays,
      removed,
    }),
  );
} finally {
  await pool.end();
}
