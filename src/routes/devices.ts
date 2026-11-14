import { Router } from "express";

import type { Config } from "../config.js";
import { normalizeDeviceKeys } from "../crypto/envelope.js";
import type { Database } from "../db/client.js";
import { asyncHandler } from "../http/errors.js";
import { createRateLimiter, getAuth, requireCsrf, requireSession } from "../http/middleware.js";
import { toOwnDevice } from "../http/serializers.js";
import { registerDeviceBodySchema, searchUsersQuerySchema } from "../http/validation.js";
import {
  listDevices,
  registerDevice,
  revokeDevice,
  searchUser,
} from "../services/accounts.js";

export function createDevicesRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);
  const csrf = requireCsrf(config);

  router.get(
    "/",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const devices = await listDevices(db, auth.userId);
      res.json({ devices: devices.map(toOwnDevice) });
    }),
  );

  router.post(
    "/",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = registerDeviceBodySchema.parse(req.body);
      const keys = normalizeDeviceKeys(body);
      const device = await registerDevice(db, {
        userId: auth.userId,
        name: body.name,
        ...keys,
      });
      res.status(201).json({ device: toOwnDevice(device) });
    }),
  );

  router.delete(
    "/:deviceId",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const deviceId = String(req.params.deviceId ?? "");
      const device = await revokeDevice(db, { userId: auth.userId, deviceId });
      res.json({ device: toOwnDevice(device) });
    }),
  );

  return router;
}

export function createUsersRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);
  const searchLimiter = createRateLimiter({
    windowMs: config.searchRateLimitWindowMs,
    max: config.searchRateLimitMax,
    key: (req) => req.auth?.userId ?? req.ip ?? "unknown",
    message: "Too many searches",
  });

  /** username 정확 일치 검색. 부분 검색·이메일 노출은 하지 않는다. */
  router.get(
    "/search",
    session,
    searchLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const query = searchUsersQuerySchema.parse(req.query);
      const user = await searchUser(db, {
        username: query.username,
        excludeUserId: auth.userId,
      });
      res.json({
        user: user ? { id: user.id, username: user.username, deleted: false } : null,
      });
    }),
  );

  return router;
}
