import { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { asyncHandler } from "../http/errors.js";
import {
  createRateLimiter,
  getAuth,
  requireAdmin,
  requireCsrf,
  requireSession,
} from "../http/middleware.js";
import {
  adminAuthEventsQuerySchema,
  adminDeviceListQuerySchema,
  adminDeviceParamsSchema,
  adminUserIdParamsSchema,
  adminUserListQuerySchema,
  decoyCreateBodySchema,
  decoyDisabledBodySchema,
  decoyPasswordBodySchema,
  decoyProfileParamsSchema,
} from "../http/validation.js";
import {
  getAdminDeviceSessions,
  getAdminOverview,
  getAdminUserDetail,
  listAdminAudit,
  listAdminDevices,
  listAdminUsers,
  revokeAdminDevice,
  revokeDeviceSessions,
  revokeUserSessions,
} from "../services/admin.js";
import {
  createDecoyProfile,
  listDecoyProfiles,
  rotateDecoyPassword,
  setDecoyProfileDisabled,
} from "../services/decoyProfiles.js";
import { listAuthEvents, recordAuthEvent } from "../services/authEvents.js";

/**
 * 관리자 전용 API. ADMIN_USERNAMES allowlist + 세션 + CSRF 를 모두 통과해야 한다.
 * 평문·키·세션 토큰·비밀번호 해시는 어떤 응답에도 포함하지 않는다.
 */
export function createAdminRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);
  const admin = requireAdmin(config);
  const csrf = requireCsrf(config);
  const decoyLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 20,
    key: (req) => req.auth?.userId ?? req.ip ?? "unknown",
    message: "Too many admin actions",
  });

  router.use(session, admin);

  router.get(
    "/overview",
    asyncHandler(async (_req, res) => {
      res.json({ overview: await getAdminOverview(db) });
    }),
  );

  router.get(
    "/users",
    asyncHandler(async (req, res) => {
      const query = adminUserListQuerySchema.parse(req.query);
      res.json(await listAdminUsers(db, query));
    }),
  );

  router.get(
    "/users/:userId",
    asyncHandler(async (req, res) => {
      const { userId } = adminUserIdParamsSchema.parse(req.params);
      res.json({ user: await getAdminUserDetail(db, userId) });
    }),
  );

  /** 사용자별 로그인·로그아웃·복구·기기 이벤트(관리자 전용, IP 포함). */
  router.get(
    "/users/:userId/auth-events",
    asyncHandler(async (req, res) => {
      const { userId } = adminUserIdParamsSchema.parse(req.params);
      const query = adminAuthEventsQuerySchema.parse(req.query);
      res.json(
        await listAuthEvents(db, {
          userId,
          before: query.before,
          limit: query.limit,
        }),
      );
    }),
  );

  router.get(
    "/devices",
    asyncHandler(async (req, res) => {
      const query = adminDeviceListQuerySchema.parse(req.query);
      res.json(await listAdminDevices(db, query));
    }),
  );

  router.post(
    "/devices/:deviceId/revoke",
    csrf,
    decoyLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { deviceId } = adminDeviceParamsSchema.parse(req.params);
      const result = await revokeAdminDevice(db, {
        adminUserId: auth.userId,
        adminUsername: auth.username,
        deviceId,
      });
      res.json(result);
    }),
  );

  router.get(
    "/devices/:deviceId/sessions",
    asyncHandler(async (req, res) => {
      const { deviceId } = adminDeviceParamsSchema.parse(req.params);
      res.json(await getAdminDeviceSessions(db, deviceId));
    }),
  );

  router.post(
    "/devices/:deviceId/revoke-sessions",
    csrf,
    decoyLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { deviceId } = adminDeviceParamsSchema.parse(req.params);
      const result = await revokeDeviceSessions(db, {
        adminUserId: auth.userId,
        adminUsername: auth.username,
        deviceId,
      });
      res.json(result);
    }),
  );

  router.post(
    "/users/:userId/revoke-sessions",
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { userId } = adminUserIdParamsSchema.parse(req.params);
      const result = await revokeUserSessions(db, {
        adminUserId: auth.userId,
        adminUsername: auth.username,
        targetUserId: userId,
      });
      await recordAuthEvent(db, {
        userId,
        deviceId: null,
        event: "admin_sessions_revoked",
        ip: req.ip ?? null,
        userAgent: req.header("user-agent") ?? null,
      });
      res.json(result);
    }),
  );

  router.get(
    "/audit",
    asyncHandler(async (_req, res) => {
      res.json({ entries: await listAdminAudit(db) });
    }),
  );

  router.get(
    "/decoy",
    asyncHandler(async (_req, res) => {
      res.json({ profiles: await listDecoyProfiles(db) });
    }),
  );

  router.post(
    "/decoy",
    csrf,
    decoyLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = decoyCreateBodySchema.parse(req.body);
      const profile = await createDecoyProfile(db, {
        adminUserId: auth.userId,
        adminUsername: auth.username,
        ...body,
      });
      res.status(201).json({ profile });
    }),
  );

  router.post(
    "/decoy/:profileId/password",
    csrf,
    decoyLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { profileId } = decoyProfileParamsSchema.parse(req.params);
      const body = decoyPasswordBodySchema.parse(req.body);
      const profile = await rotateDecoyPassword(db, {
        adminUserId: auth.userId,
        adminUsername: auth.username,
        profileId,
        password: body.password,
      });
      res.json({ profile });
    }),
  );

  router.post(
    "/decoy/:profileId/disabled",
    csrf,
    decoyLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { profileId } = decoyProfileParamsSchema.parse(req.params);
      const body = decoyDisabledBodySchema.parse(req.body);
      const profile = await setDecoyProfileDisabled(db, {
        adminUserId: auth.userId,
        adminUsername: auth.username,
        profileId,
        disabled: body.disabled,
      });
      res.json({ profile });
    }),
  );

  return router;
}
