import { Router } from "express";

import type { Config } from "../config.js";
import { normalizeDeviceKeys } from "../crypto/envelope.js";
import type { Database } from "../db/client.js";
import { asyncHandler } from "../http/errors.js";
import { createRateLimiter, getAuth, requireCsrf, requireSession } from "../http/middleware.js";
import { toOwnDevice } from "../http/serializers.js";
import { recordAuthEvent } from "../services/authEvents.js";
import {
  deviceIdParamsSchema,
  registerDeviceBodySchema,
  searchUsersQuerySchema,
  updateDeviceIdleTimeoutBodySchema,
} from "../http/validation.js";
import {
  listDevices,
  registerDevice,
  revokeDevice,
  searchUser,
  updateDeviceIdleTimeout,
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
        platform: body.platform,
        ...keys,
      });
      res.status(201).json({ device: toOwnDevice(device) });
    }),
  );

  router.put(
    "/:deviceId/timeout",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const params = deviceIdParamsSchema.parse(req.params);
      const body = updateDeviceIdleTimeoutBodySchema.parse(req.body);
      const device = await updateDeviceIdleTimeout(db, {
        userId: auth.userId,
        deviceId: params.deviceId,
        seconds: body.seconds,
      });
      res.json({ device: toOwnDevice(device) });
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
      await recordAuthEvent(db, {
        userId: auth.userId,
        deviceId: device.id,
        event: "device_revoked",
        ip: req.ip ?? null,
        userAgent: req.header("user-agent") ?? null,
      });
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
