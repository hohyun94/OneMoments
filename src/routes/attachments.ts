import { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { AppError, asyncHandler } from "../http/errors.js";
import { getAuth, requireSession } from "../http/middleware.js";
import { attachmentIdParamsSchema } from "../http/validation.js";
import { requireParticipant } from "../services/conversations.js";
import {
  createAttachmentStorage,
  findAttachment,
  markAttachmentAccessed,
} from "../services/attachments.js";

/** 참여자만 첨부 암호문을 내려받을 수 있다. 서버는 복호화하지 않는다. */
export function createAttachmentsRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);
  const storage = createAttachmentStorage(config);

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

      const total = await storage.size(attachment.id);
      if (total === null) {
        throw AppError.notFound("ATTACHMENT_NOT_FOUND", "Attachment not found");
      }
      await markAttachmentAccessed(db, attachment.id);

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", 'attachment; filename="attachment.bin"');
      // 암호문 그대로 전달한다(서버는 복호화하지 않는다). Range 는 부분 다운로드용이며,
      // 클라이언트는 아직 전체를 받아 한 번에 복호화한다(청크 암호화/MSE 는 후속).
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "private, no-store");

      const rangeHeader = req.headers.range?.trim();
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (match) {
          const startText = match[1] ?? "";
          const endText = match[2] ?? "";
          let start = startText === "" ? Number.NaN : Number(startText);
          let end = endText === "" ? Number.NaN : Number(endText);

          if (startText === "" && Number.isFinite(end) && end > 0) {
            // bytes=-N : 마지막 N 바이트
            start = Math.max(0, total - end);
            end = total - 1;
          } else if (Number.isFinite(start)) {
            end = Number.isFinite(end) ? Math.min(end, total - 1) : total - 1;
          }

          if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
            const data = await storage.getRange(attachment.id, start, end);
            res.status(206);
            res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
            res.setHeader("Content-Length", String(data.byteLength));
            res.send(data);
            return;
          }
        }
        res.setHeader("Content-Range", `bytes */${total}`);
        res.status(416).json({
          error: { code: "RANGE_NOT_SATISFIABLE", message: "Invalid range" },
        });
        return;
      }

      let data: Buffer;
      try {
        data = await storage.get(attachment.id);
      } catch {
        throw AppError.notFound("ATTACHMENT_NOT_FOUND", "Attachment not found");
      }
      res.setHeader("Content-Length", String(data.byteLength));
      res.send(data);
    }),
  );

  return router;
}
