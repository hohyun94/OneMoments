import { loadConfig } from "../dist/config.js";
import { createDb } from "../dist/db/client.js";
import { createAttachmentStorage } from "../dist/services/attachments.js";
import { cleanupAutoDeletedMessages } from "../dist/services/autoDelete.js";

const config = loadConfig();
const { db, pool } = createDb(config);
const storage = createAttachmentStorage(config);

let messages = 0;
let attachmentCount = 0;
try {
  for (let batch = 0; batch < 20; batch += 1) {
    const result = await cleanupAutoDeletedMessages(db, storage, { limit: 200 });
    messages += result.deletedMessages;
    attachmentCount += result.deletedAttachments;
    if (result.deletedMessages === 0) break;
  }
  console.log(
    JSON.stringify({
      level: "info",
      event: "auto_delete_cleanup",
      storage: config.attachmentStorage,
      deletedMessages: messages,
      deletedAttachments: attachmentCount,
    }),
  );
} finally {
  await pool.end();
}
