import { Router, type Request } from "express";

import { issueSession } from "../auth/issueSession.js";
import {
  SESSION_COOKIE,
  clearSessionCookieOptions,
  deriveCsrfToken,
  sessionCookieOptions,
} from "../auth/session.js";
import type { Config } from "../config.js";
import { normalizeDeviceKeys } from "../crypto/envelope.js";
import type { Database } from "../db/client.js";
import { AppError, asyncHandler } from "../http/errors.js";
import {
  createRateLimiter,
  getAuth,
  requireCsrf,
  requireSession,
} from "../http/middleware.js";
import { toOwnDevice, toPublicDevice, toPublicUser } from "../http/serializers.js";
import { loginBodySchema, registerBodySchema, deleteAccountBodySchema } from "../http/validation.js";
import {
  deleteAccount,
  deleteSession,
  deleteSessionsForDevice,
  findActiveDevice,
  findUserById,
  listDevices,
  registerAccount,
  registerDevice,
  verifyCredentials,
} from "../services/accounts.js";

function userAgent(req: Request): string | null {
  return req.header("user-agent") ?? null;
}

export function createAuthRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);
  const csrf = requireCsrf(config);
  const credentialLimiter = createRateLimiter({
    windowMs: config.authRateLimitWindowMs,
    max: config.authRateLimitMax,
    key: (req) => req.ip ?? "unknown",
    message: "Too many authentication attempts",
  });

  router.post(
    "/register",
    credentialLimiter,
    asyncHandler(async (req, res) => {
      const body = registerBodySchema.parse(req.body);
      const keys = normalizeDeviceKeys(body.device);
      const { user, device } = await registerAccount(db, {
        username: body.username,
        password: body.password,
        deviceName: body.device.name,
        ...keys,
      });

      const issued = await issueSession(db, config, {
        userId: user.id,
        deviceId: device.id,
        userAgent: userAgent(req),
      });
      res.cookie(SESSION_COOKIE, issued.token, sessionCookieOptions(config));
      res.status(201).json({
        user: toPublicUser(user),
        device: toPublicDevice(device),
        csrfToken: issued.csrfToken,
        expiresAt: issued.expiresAt.toISOString(),
      });
    }),
  );

  router.post(
    "/login",
    credentialLimiter,
    asyncHandler(async (req, res) => {
      const body = loginBodySchema.parse(req.body);
      const user = await verifyCredentials(db, {
        username: body.username,
        password: body.password,
      });

      // 쿠키 세션은 항상 기기에 묶는다. 새 브라우저는 device 를 함께 보내 등록한다.
      let device;
      if (body.deviceId) {
        device = await findActiveDevice(db, { userId: user.id, deviceId: body.deviceId });
        if (!device) throw AppError.unauthorized("Device revoked or unknown");
      } else if (body.device) {
        const keys = normalizeDeviceKeys(body.device);
        device = await registerDevice(db, {
          userId: user.id,
          name: body.device.name,
          ...keys,
        });
      } else {
        throw AppError.badRequest(
          "DEVICE_REQUIRED",
          "Provide deviceId for an existing device or device keys to register a new one",
        );
      }

      // 같은 기기의 이전 세션은 폐기한다(세션 회전).
      await deleteSessionsForDevice(db, device.id);

      const issued = await issueSession(db, config, {
        userId: user.id,
        deviceId: device.id,
        userAgent: userAgent(req),
      });
      res.cookie(SESSION_COOKIE, issued.token, sessionCookieOptions(config));
      res.json({
        user: toPublicUser(user),
        device: toPublicDevice(device),
        csrfToken: issued.csrfToken,
        expiresAt: issued.expiresAt.toISOString(),
      });
    }),
  );

  router.delete(
    "/account",
    credentialLimiter,
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = deleteAccountBodySchema.parse(req.body);
      await deleteAccount(db, { userId: auth.userId, password: body.password });
      res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions(config));
      res.status(204).end();
    }),
  );

  router.post(
    "/logout",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      await deleteSession(db, auth.sessionId);
      res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions(config));
      res.status(204).end();
    }),
  );

  router.get(
    "/csrf",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      res.json({ csrfToken: deriveCsrfToken(auth.sessionToken, config.sessionSecret) });
    }),
  );

  router.get(
    "/me",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const user = await findUserById(db, auth.userId);
      if (!user || user.deletedAt !== null) throw AppError.unauthorized();
      const devices = await listDevices(db, auth.userId);
      res.json({
        user: toPublicUser(user),
        deviceId: auth.deviceId,
        devices: devices.map(toOwnDevice),
        csrfToken: deriveCsrfToken(auth.sessionToken, config.sessionSecret),
      });
    }),
  );

  return router;
}
