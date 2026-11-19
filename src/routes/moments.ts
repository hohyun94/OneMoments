import express, { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { AppError, asyncHandler } from "../http/errors.js";
import { createRateLimiter, getAuth, requireCsrf, requireSession } from "../http/middleware.js";
import {
  attachmentIdParamsSchema,
  momentBodySchema,
  momentIdParamsSchema,
} from "../http/validation.js";
import {
  cleanupExpiredMoments,
  createMoment,
  createMomentAttachment,
  deleteMoment,
  getMomentForUser,
  listMomentContacts,
  listMomentFeed,
  listMomentViews,
  markMomentAttachmentAccessed,
  markMomentViewed,
  requireMomentAttachmentAccess,
} from "../services/moments.js";
import { createAttachmentStorage } from "../services/attachments.js";

export function createMomentsRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);
  const csrf = requireCsrf(config);
  const storage = createAttachmentStorage(config);
  const momentLimiter = createRateLimiter({
    windowMs: config.messageRateLimitWindowMs,
    max: Math.max(4, Math.floor(config.messageRateLimitMax / 4)),
    key: (req) => req.auth?.userId ?? req.ip ?? "unknown",
    message: "Moment rate limit exceeded",
  });

  let lastCleanupAt = 0;
  async function maybeCleanup(): Promise<void> {
    const now = Date.now();
    if (now - lastCleanupAt < 60_000) return;
    lastCleanupAt = now;
    try {
      await cleanupExpiredMoments(db, storage, {
        orphanBefore: new Date(now - config.attachmentTtlDays * 24 * 60 * 60 * 1000),
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "moment_cleanup_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  router.get(
    "/contacts",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      res.json(await listMomentContacts(db, auth.userId));
    }),
  );

  router.post(
    "/attachments",
    session,
    csrf,
    express.raw({ type: "application/octet-stream", limit: config.attachmentMaxBytes }),
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
        throw AppError.badRequest("EMPTY_ATTACHMENT", "Attachment body is empty");
      }
      if (req.body.byteLength > config.attachmentMaxBytes) {
        throw AppError.payloadTooLarge("Attachment is too large");
      }
      const rawMomentId = req.header("x-moment-id");
      if (
        rawMomentId !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawMomentId)
      ) {
        throw AppError.badRequest("INVALID_ATTACHMENT", "x-moment-id must be a UUID");
      }
      const attachment = await createMomentAttachment(db, storage, {
        uploaderUserId: auth.userId,
        clientMomentId: rawMomentId ?? null,
        data: req.body,
      });
      res.status(201).json({ attachment: { id: attachment.id, size: attachment.size } });
    }),
  );

  router.get(
    "/attachments/:attachmentId",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { attachmentId } = attachmentIdParamsSchema.parse(req.params);
      const attachment = await requireMomentAttachmentAccess(db, {
        attachmentId,
        userId: auth.userId,
      });
      let data: Buffer;
      try {
        data = await storage.get(attachment.id);
      } catch {
        throw AppError.notFound("ATTACHMENT_NOT_FOUND", "Attachment not found");
      }
      await markMomentAttachmentAccessed(db, attachment.id);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(data.byteLength));
      res.setHeader("Content-Disposition", 'attachment; filename="moment.bin"');
      res.send(data);
    }),
  );

  router.post(
    "/",
    session,
    csrf,
    momentLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = momentBodySchema.parse(req.body);
      const moment = await createMoment(db, config, {
        ...body,
        authorUserId: auth.userId,
        authorDeviceId: auth.deviceId,
      });
      res.status(201).json({ moment });
    }),
  );

  router.get(
    "/feed",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      await maybeCleanup();
      res.json({
        moments: await listMomentFeed(db, {
          userId: auth.userId,
          deviceId: auth.deviceId,
        }),
      });
    }),
  );

  router.get(
    "/:momentId/views",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { momentId } = momentIdParamsSchema.parse(req.params);
      const views = await listMomentViews(db, { momentId, userId: auth.userId });
      res.json({
        views: views.map((view) => ({
          userId: view.userId,
          username: view.username,
          viewedAt: view.viewedAt.toISOString(),
        })),
      });
    }),
  );

  router.post(
    "/:momentId/view",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { momentId } = momentIdParamsSchema.parse(req.params);
      await markMomentViewed(db, { momentId, userId: auth.userId });
      res.status(204).end();
    }),
  );

  router.get(
    "/:momentId",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { momentId } = momentIdParamsSchema.parse(req.params);
      await maybeCleanup();
      res.json({
        moment: await getMomentForUser(db, {
          momentId,
          userId: auth.userId,
          deviceId: auth.deviceId,
        }),
      });
    }),
  );

  router.delete(
    "/:momentId",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { momentId } = momentIdParamsSchema.parse(req.params);
      await deleteMoment(db, storage, { momentId, userId: auth.userId });
      res.status(204).end();
    }),
  );

  return router;
}
