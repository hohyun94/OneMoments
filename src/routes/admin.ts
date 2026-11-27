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
  createSignupInviteBodySchema,
  decoyCreateBodySchema,
  decoyDisabledBodySchema,
  decoyPasswordBodySchema,
  decoyProfileParamsSchema,
  rejectSignupRequestBodySchema,
  signupInviteParamsSchema,
  signupRequestParamsSchema,
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
  approveSignupRequest,
  listSignupRequests,
  rejectSignupRequest,
} from "../services/signupRequests.js";
import {
  createDecoyProfile,
  listDecoyProfiles,
  rotateDecoyPassword,
  setDecoyProfileDisabled,
} from "../services/decoyProfiles.js";
import { listAuthEvents, recordAuthEvent } from "../services/authEvents.js";
import {
  createSignupInvite,
  listSignupInvites,
  revokeSignupInvite,
} from "../services/signupInvites.js";

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
    "/signup-invites",
    asyncHandler(async (_req, res) => {
      const invites = await listSignupInvites(db);
      res.json({
        invites: invites.map((invite) => ({
          id: invite.id,
          code: invite.code,
          maxUses: invite.maxUses,
          usedCount: invite.usedCount,
          expiresAt: invite.expiresAt?.toISOString() ?? null,
          revokedAt: invite.revokedAt?.toISOString() ?? null,
          createdAt: invite.createdAt.toISOString(),
          active:
            invite.revokedAt === null &&
            (invite.expiresAt === null || invite.expiresAt.getTime() > Date.now()) &&
            invite.usedCount < invite.maxUses,
        })),
        signupMode: config.signupMode,
      });
    }),
  );

  router.post(
    "/signup-invites",
    csrf,
    decoyLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = createSignupInviteBodySchema.parse(req.body);
      const expiresAt =
        body.expiresInDays != null
          ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
          : null;
      const invite = await createSignupInvite(db, {
        createdByUserId: auth.userId,
        maxUses: body.maxUses,
        expiresAt,
      });
      await recordAuthEvent(db, {
        userId: auth.userId,
        event: "admin_signup_invite_created",
        ip: req.ip ?? null,
        userAgent: null,
      });
      res.status(201).json({
        invite: {
          id: invite.id,
          code: invite.code,
          maxUses: invite.maxUses,
          usedCount: invite.usedCount,
          expiresAt: invite.expiresAt?.toISOString() ?? null,
          createdAt: invite.createdAt.toISOString(),
        },
      });
    }),
  );

  router.delete(
    "/signup-invites/:inviteId",
    csrf,
    decoyLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { inviteId } = signupInviteParamsSchema.parse(req.params);
      const revoked = await revokeSignupInvite(db, { id: inviteId });
      await recordAuthEvent(db, {
        userId: auth.userId,
        event: "admin_signup_invite_revoked",
        ip: req.ip ?? null,
        userAgent: null,
      });
      res.json({ revoked });
    }),
  );

  /** 가입 신청 목록(관리자 승인 대기 포함). */
  router.get(
    "/signup-requests",
    asyncHandler(async (_req, res) => {
      const requests = await listSignupRequests(db);
      res.json({ requests, signupRequestEnabled: config.signupRequestEnabled });
    }),
  );

  /** 승인 — 1회용 초대 코드를 발급하고, 그 코드를 응답에 담아 관리자가 신청자에게 전달한다. */
  router.post(
    "/signup-requests/:requestId/approve",
    csrf,
    decoyLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { requestId } = signupRequestParamsSchema.parse(req.params);
      const request = await approveSignupRequest(db, {
        requestId,
        adminUserId: auth.userId,
        adminUsername: auth.username,
      });
      res.json({
        request: {
          id: request.id,
          username: request.username,
          status: request.status,
          decidedAt: request.decidedAt?.toISOString() ?? null,
        },
      });
    }),
  );

  /** 거절 — 사유(선택)를 남긴다. */
  router.post(
    "/signup-requests/:requestId/reject",
    csrf,
    decoyLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { requestId } = signupRequestParamsSchema.parse(req.params);
      const body = rejectSignupRequestBodySchema.parse(req.body ?? {});
      const request = await rejectSignupRequest(db, {
        requestId,
        adminUserId: auth.userId,
        adminUsername: auth.username,
        note: body.note,
      });
      res.json({
        request: {
          id: request.id,
          username: request.username,
          status: request.status,
          decidedAt: request.decidedAt?.toISOString() ?? null,
          reviewNote: request.reviewNote,
        },
      });
    }),
  );

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
