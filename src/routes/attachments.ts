import { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { AppError, asyncHandler } from "../http/errors.js";
import { getAuth, requireSession } from "../http/middleware.js";
import { attachmentIdParamsSchema } from "../http/validation.js";
import { requireParticipant } from "../services/conversations.js";
import { findAttachment, readAttachmentBlob } from "../services/attachments.js";

/** 참여자만 첨부 암호문을 내려받을 수 있다. 서버는 복호화하지 않는다. */
export function createAttachmentsRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);

  router.get(
    "/:attachmentId",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { attachmentId } = attachmentIdParamsSchema.parse(req.params);
      const attachment = await findAttachment(db, attachmentId);
      if (!attachment) {
        throw AppError.notFound("ATTACHMENT_NOT_FOUND", "Attachment not found");
      }
      await requireParticipant(db, {
        conversationId: attachment.conversationId,
        userId: auth.userId,
      });

      let data: Buffer;
      try {
        data = await readAttachmentBlob(config.attachmentDir, attachment.id);
      } catch {
        throw AppError.notFound("ATTACHMENT_NOT_FOUND", "Attachment not found");
      }

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(data.byteLength));
      res.setHeader("Content-Disposition", 'attachment; filename="attachment.bin"');
      res.send(data);
    }),
  );

  return router;
}
