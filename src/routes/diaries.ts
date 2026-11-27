import { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { asyncHandler } from "../http/errors.js";
import { createRateLimiter, getAuth, requireCsrf, requireSession } from "../http/middleware.js";
import {
  createDiaryBodySchema,
  createDiaryEntryBodySchema,
  diaryEntryParamsSchema,
  diaryIdParamsSchema,
  diaryListQuerySchema,
  updateDiaryAudienceBodySchema,
} from "../http/validation.js";
import {
  createDiary,
  createDiaryEntry,
  deleteDiaryEntry,
  getDiaryDetail,
  getDiaryEntry,
  listDiaries,
  listDiaryEntries,
  updateDiaryAudience,
} from "../services/diaries.js";

/**
 * 일기장 API. 모두 세션 기반이며, 쓰기(POST/DELETE)는 CSRF 를 요구한다.
 * 본문은 암호문만 오가고 서버는 복호화하지 않는다.
 */
export function createDiariesRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);
  const csrf = requireCsrf(config);
  const writeLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 60,
    key: (req) => req.auth?.userId ?? req.ip ?? "unknown",
    message: "Too many diary actions",
  });

  router.use(session);

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
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
