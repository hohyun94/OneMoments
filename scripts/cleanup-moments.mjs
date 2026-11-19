import { loadConfig } from "../dist/config.js";
import { createDb } from "../dist/db/client.js";
import { createAttachmentStorage } from "../dist/services/attachments.js";
import { cleanupExpiredMoments } from "../dist/services/moments.js";

const config = loadConfig();
const { db, pool } = createDb(config);
const storage = createAttachmentStorage(config);
const orphanBefore = new Date(
  Date.now() - config.attachmentTtlDays * 24 * 60 * 60 * 1000,
);

try {
  const result = await cleanupExpiredMoments(db, storage, { orphanBefore });
  console.log(
    JSON.stringify({
      level: "info",
      event: "moment_cleanup",
      storage: config.attachmentStorage,
      moments: result.moments,
      attachments: result.attachments,
    }),
  );
} finally {
  await pool.end();
}
