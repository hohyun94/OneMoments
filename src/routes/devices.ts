import { Router } from "express";

import type { Config } from "../config.js";
import { normalizeDeviceKeys } from "../crypto/envelope.js";
import type { Database } from "../db/client.js";
import { asyncHandler, AppError } from "../http/errors.js";
import { createRateLimiter, getAuth, requireCsrf, requireSession } from "../http/middleware.js";
import { toOwnDevice } from "../http/serializers.js";
import { recordAuthEvent } from "../services/authEvents.js";
import { findUserAvatar } from "../services/avatars.js";
import {
  contactUserIdParamsSchema,
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
        user: user
          ? {
              id: user.id,
              username: user.username,
              avatarUpdatedAt: user.avatarUpdatedAt?.toISOString() ?? null,
              deleted: false,
            }
          : null,
      });
    }),
  );

  /**
   * 공개 프로필 아바타 이미지.
   * 로그인한 사용자면 조회할 수 있고(상태 메시지와 동일한 공개 범위), 변경 시각으로 캐시를 무효화한다.
   */
  router.get(
    "/:userId/avatar",
    session,
    asyncHandler(async (req, res) => {
      const params = contactUserIdParamsSchema.parse(req.params);
      const avatar = await findUserAvatar(db, { userId: params.userId });
      if (!avatar) throw AppError.notFound("Avatar not found");
      const etag = `"${avatar.updatedAt?.getTime() ?? avatar.data.length.toString(16)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }
      res.setHeader("Content-Type", avatar.mime);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("ETag", etag);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(avatar.data);
    }),
  );

  return router;
}
