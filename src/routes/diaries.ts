import express, { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { AppError, asyncHandler } from "../http/errors.js";
import { createRateLimiter, getAuth, requireCsrf, requireSession } from "../http/middleware.js";
import {
  createDiaryBodySchema,
  createDiaryEntryBodySchema,
  diaryAttachmentParamsSchema,
  diaryEntryParamsSchema,
  diaryIdParamsSchema,
  diaryListQuerySchema,
  renameDiaryBodySchema,
  updateDiaryAudienceBodySchema,
} from "../http/validation.js";
import { createAttachmentStorage } from "../services/attachments.js";
import {
  cleanupOrphanDiaryAttachments,
  createDiary,
  createDiaryAttachment,
  createDiaryEntry,
  deleteDiary,
  deleteDiaryEntry,
  getDiaryDetail,
  getDiaryEntry,
  listDiaries,
  listDiaryEntries,
  renameDiary,
  requireDiaryAttachmentAccess,
  updateDiaryAudience,
} from "../services/diaries.js";

/**
 * 일기장 API. 모두 세션 기반이며, 쓰기(POST/DELETE)는 CSRF 를 요구한다.
 * 본문은 암호문만 오가고 서버는 복호화하지 않는다.
 */
export function createDiariesRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);
  const storage = createAttachmentStorage(config);
  /** 고아 첨부 정리 스로틀(1시간). */
  let lastOrphanCleanupAt = 0;
  const csrf = requireCsrf(config);
  const writeLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 60,
    key: (req) => req.auth?.userId ?? req.ip ?? "unknown",
    message: "Too many diary actions",
  });

  router.use(session);

  /** 사진 업로드 — 암호문 블롭만 받는다. 응답은 id/size 뿐(파일명·MIME 없음). */
  router.post(
    "/attachments",
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
      const rawClientEntryId = req.header("x-diary-entry-id");
      if (
        rawClientEntryId !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          rawClientEntryId,
        )
      ) {
        throw AppError.badRequest("INVALID_ATTACHMENT", "x-diary-entry-id must be a UUID");
      }
      const attachment = await createDiaryAttachment(db, storage, {
        uploaderUserId: auth.userId,
        clientEntryId: rawClientEntryId ?? null,
        data: req.body,
      });
      res.status(201).json({ attachment: { id: attachment.id, size: attachment.size } });
    }),
  );

  /** 사진 다운로드 — 글에 연결된 뒤에는 일기장 멤버만, 예약 상태에서는 업로더만. */
  router.get(
    "/attachments/:attachmentId",
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { attachmentId } = diaryAttachmentParamsSchema.parse(req.params);
      const attachment = await requireDiaryAttachmentAccess(db, {
        attachmentId,
        userId: auth.userId,
      });
      let data: Buffer;
      try {
        data = await storage.get(attachment.id);
      } catch {
        throw AppError.notFound("ATTACHMENT_NOT_FOUND", "Attachment not found");
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(data.byteLength));
      res.setHeader("Content-Disposition", 'attachment; filename="diary.bin"');
      res.send(data);
    }),
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      if (Date.now() - lastOrphanCleanupAt > 60 * 60 * 1000) {
        lastOrphanCleanupAt = Date.now();
        void cleanupOrphanDiaryAttachments(db, storage, 24).catch(() => undefined);
      }
      res.json({ diaries: await listDiaries(db, auth.userId) });
    }),
  );

  router.post(
    "/",
    csrf,
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = createDiaryBodySchema.parse(req.body);
      const created = await createDiary(db, {
        ownerUserId: auth.userId,
        label: body.label,
        audienceUserIds: body.audienceUserIds,
      });
      res.status(201).json(created);
    }),
  );

  router.get(
    "/:diaryId",
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { diaryId } = diaryIdParamsSchema.parse(req.params);
      res.json(await getDiaryDetail(db, diaryId, auth.userId));
    }),
  );

  router.put(
    "/:diaryId/audience",
    csrf,
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { diaryId } = diaryIdParamsSchema.parse(req.params);
      const body = updateDiaryAudienceBodySchema.parse(req.body);
      res.json(
        await updateDiaryAudience(db, {
          diaryId,
          ownerUserId: auth.userId,
          audienceUserIds: body.audienceUserIds,
        }),
      );
    }),
  );

  router.put(
    "/:diaryId",
    csrf,
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { diaryId } = diaryIdParamsSchema.parse(req.params);
      const body = renameDiaryBodySchema.parse(req.body);
      res.json(await renameDiary(db, { diaryId, ownerUserId: auth.userId, label: body.label }));
    }),
  );

  router.delete(
    "/:diaryId",
    csrf,
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { diaryId } = diaryIdParamsSchema.parse(req.params);
      res.json(await deleteDiary(db, { diaryId, ownerUserId: auth.userId }));
    }),
  );

  router.get(
    "/:diaryId/entries",
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { diaryId } = diaryIdParamsSchema.parse(req.params);
      const query = diaryListQuerySchema.parse(req.query);
      res.json({
        entries: await listDiaryEntries(db, {
          diaryId,
          userId: auth.userId,
          limit: query.limit,
        }),
      });
    }),
  );

  router.post(
    "/:diaryId/entries",
    csrf,
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { diaryId } = diaryIdParamsSchema.parse(req.params);
      const body = createDiaryEntryBodySchema.parse(req.body);
      const created = await createDiaryEntry(db, config, {
        diaryId,
        authorUserId: auth.userId,
        authorDeviceId: auth.deviceId,
        clientEntryId: body.clientEntryId,
        ciphertext: body.ciphertext,
        nonce: body.nonce,
        signature: body.signature,
        keys: body.keys,
      });
      res.status(201).json(created);
    }),
  );

  router.get(
    "/entries/:entryId",
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { entryId } = diaryEntryParamsSchema.parse(req.params);
      res.json(await getDiaryEntry(db, entryId, auth.userId));
    }),
  );

  router.delete(
    "/entries/:entryId",
    csrf,
    writeLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { entryId } = diaryEntryParamsSchema.parse(req.params);
      res.json(await deleteDiaryEntry(db, entryId, auth.userId));
    }),
  );

  return router;
}
