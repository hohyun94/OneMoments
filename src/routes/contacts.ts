import { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { asyncHandler } from "../http/errors.js";
import { getAuth, requireCsrf, requireSession } from "../http/middleware.js";
import {
  contactUserIdParamsSchema,
  updateBlockBodySchema,
  updateFavoriteBodySchema,
} from "../http/validation.js";
import {
  listContacts,
  setContactBlocked,
  setContactFavorite,
} from "../services/contacts.js";

export function createContactsRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);
  const csrf = requireCsrf(config);

  router.get(
    "/",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      res.json({ contacts: await listContacts(db, auth.userId) });
    }),
  );

  router.put(
    "/:userId/favorite",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const params = contactUserIdParamsSchema.parse(req.params);
      const body = updateFavoriteBodySchema.parse(req.body);
      await setContactFavorite(db, {
        userId: auth.userId,
        targetUserId: params.userId,
        favorite: body.favorite,
      });
      res.json({ userId: params.userId, favorite: body.favorite });
    }),
  );

  router.put(
    "/:userId/block",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const params = contactUserIdParamsSchema.parse(req.params);
      const body = updateBlockBodySchema.parse(req.body);
      await setContactBlocked(db, {
        userId: auth.userId,
        targetUserId: params.userId,
        blocked: body.blocked,
      });
      res.json({ userId: params.userId, blocked: body.blocked });
    }),
  );

  return router;
}
