import express, { Router, type Request } from "express";

import { isAdminUsername } from "../auth/admin.js";
import { DEFAULT_IDLE_TIMEOUT_SECONDS } from "../auth/idleTimeout.js";
import { issueSession } from "../auth/issueSession.js";
import {
  SESSION_COOKIE,
  clearSessionCookieOptions,
  deriveCsrfToken,
  sessionCookieOptions,
} from "../auth/session.js";
import type { Config } from "../config.js";
import { verifyEd25519Signature } from "../crypto/ed25519.js";
import { normalizeDeviceKeys } from "../crypto/envelope.js";
import type { Database } from "../db/client.js";
import type { UserRow } from "../db/schema.js";
import { AppError, asyncHandler } from "../http/errors.js";
import { recordAuthEvent } from "../services/authEvents.js";
import { removePushSubscriptionsForDevice } from "../services/push.js";
import {
  createRateLimiter,
  getAuth,
  requireCsrf,
  requireSession,
} from "../http/middleware.js";
import { toOwnDevice, toPublicDevice, toPublicUser } from "../http/serializers.js";
import {
  backupBodySchema,
  deleteAccountBodySchema,
  loginBodySchema,
  recoverBodySchema,
  recoveryChallengeBodySchema,
  recoveryLookupBodySchema,
  registerBodySchema,
  signedPreKeyBodySchema,
  oneTimePreKeysBodySchema,
  updateSessionIdleTimeoutBodySchema,
  updateThemeBodySchema,
  updateProfileBodySchema,
  updateAvatarBodySchema,
  updateLastSeenBodySchema,
} from "../http/validation.js";
import {
  addOneTimePreKeys,
  countUnusedOneTimePreKeys,
  deleteAccount,
  deleteSession,
  deleteSessionsForDevice,
  findActiveDevice,
  findUserById,
  listDevices,
  listUnusedOneTimePreKeyIds,
  registerAccount,
  registerDevice,
  updateDeviceSignedPreKey,
  updateLastSeenVisibility,
  updateSessionIdleTimeout,
  updateUserStatus,
  updateUserTheme,
  verifyLoginCredentials,
} from "../services/accounts.js";
import {
  createAttachmentStorage,
} from "../services/attachments.js";
import { clearUserAvatar, setUserAvatar } from "../services/avatars.js";
import { deleteUserMoments, listUserMomentAttachmentIds } from "../services/moments.js";
import {
  consumeRecoveryChallenge,
  createRecoveryChallenge,
  findDeviceForRecovery,
  findLatestBackupByUsername,
  getKeyBackupForDevice,
  upsertKeyBackup,
} from "../services/keyBackup.js";
import { toThemeSettings } from "../services/theme.js";

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
  const recoveryLimiter = createRateLimiter({
    windowMs: config.authRateLimitWindowMs,
    max: config.authRateLimitMax,
    key: (req) => req.ip ?? "unknown",
    message: "Too many recovery attempts",
  });

  // 관리자 여부는 ADMIN_USERNAMES allowlist 로만 판정한다.
  const authUser = (user: UserRow) => ({
    ...toPublicUser(user),
    isAdmin: isAdminUsername(config, user.username),
  });

  /** 로그인 전 화면이 Google 버튼 노출 여부를 알 수 있는 공개 설정. */
  router.get(
    "/config",
    asyncHandler(async (_req, res) => {
      res.json({
        oauthEnabled: config.googleOAuth !== null,
        mapTileUrl: config.mapTileUrl,
      });
    }),
  );

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
        platform: body.device.platform,
        ...keys,
      });

      const issued = await issueSession(db, config, {
        userId: user.id,
        deviceId: device.id,
        userAgent: userAgent(req),
      });
      await recordAuthEvent(db, {
        userId: user.id,
        deviceId: device.id,
        event: "register",
        ip: req.ip ?? null,
        userAgent: userAgent(req),
      });
      res.cookie(SESSION_COOKIE, issued.token, sessionCookieOptions(config));
      res.status(201).json({
        user: authUser(user),
        device: toPublicDevice(device),
        csrfToken: issued.csrfToken,
        expiresAt: issued.expiresAt.toISOString(),
        idleTimeoutSeconds: device.idleTimeoutSeconds,
        theme: toThemeSettings(user),
        hasPassword: user.passwordHash !== null,
        googleLinked: user.oauthSubject !== null,
      });
    }),
  );

  router.post(
    "/login",
    credentialLimiter,
    asyncHandler(async (req, res) => {
      const body = loginBodySchema.parse(req.body);
      const verified = await verifyLoginCredentials(db, {
        username: body.username,
        password: body.password,
      });
      const user = verified.user;

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
          platform: body.device.platform,
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
      await recordAuthEvent(db, {
        userId: user.id,
        deviceId: device.id,
        event: "login",
        ip: req.ip ?? null,
        userAgent: userAgent(req),
      });
      res.cookie(SESSION_COOKIE, issued.token, sessionCookieOptions(config));
      res.json({
        user: authUser(user),
        device: toPublicDevice(device),
        csrfToken: issued.csrfToken,
        expiresAt: issued.expiresAt.toISOString(),
        idleTimeoutSeconds: device.idleTimeoutSeconds,
        theme: toThemeSettings(user),
        hasPassword: user.passwordHash !== null,
        googleLinked: user.oauthSubject !== null,
      });
    }),
  );

  router.put(
    "/device/prekey",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = signedPreKeyBodySchema.parse(req.body);
      const current = await findActiveDevice(db, {
        userId: auth.userId,
        deviceId: auth.deviceId,
      });
      if (!current) throw AppError.unauthorized("Device revoked or unknown");
      const keys = normalizeDeviceKeys({
        identityPublicKey: current.identityPublicKey,
        signingPublicKey: current.signingPublicKey,
        signedPreKey: body.signedPreKey,
      });
      if (!keys.signedPreKey) {
        throw AppError.badRequest("INVALID_ENVELOPE", "signedPreKey is required");
      }
      const device = await updateDeviceSignedPreKey(db, {
        userId: auth.userId,
        deviceId: auth.deviceId,
        signedPreKey: keys.signedPreKey,
      });
      res.json({ device: toPublicDevice(device) });
    }),
  );

  router.get(
    "/device/prekeys/status",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const count = await countUnusedOneTimePreKeys(db, auth.deviceId);
      const oneTimePreKeyIds = await listUnusedOneTimePreKeyIds(db, auth.deviceId);
      res.json({ oneTimePreKeyCount: count, oneTimePreKeyIds });
    }),
  );

  router.post(
    "/device/one-time-prekeys",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = oneTimePreKeysBodySchema.parse(req.body);
      await addOneTimePreKeys(db, {
        deviceId: auth.deviceId,
        keys: body.oneTimePreKeys,
      });
      const count = await countUnusedOneTimePreKeys(db, auth.deviceId);
      const oneTimePreKeyIds = await listUnusedOneTimePreKeyIds(db, auth.deviceId);
      res.status(201).json({ oneTimePreKeyCount: count, oneTimePreKeyIds });
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
      // 계정 삭제로 모먼트 행이 cascade 삭제되기 전에 이미지 블롭 ID를 모아둔다.
      const momentAttachmentIds = await listUserMomentAttachmentIds(db, auth.userId);
      await deleteAccount(db, {
        userId: auth.userId,
        password: body.password,
        confirmUsername: body.confirmUsername,
      });
      await deleteUserMoments(db, auth.userId);
      const storage = createAttachmentStorage(config);
      await Promise.all(
        momentAttachmentIds.map((id) => storage.delete(id).catch(() => undefined)),
      );
      res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions(config));
      res.status(204).end();
    }),
  );

  router.put(
    "/backup",
    session,
    csrf,
    express.text({ type: "text/plain", limit: config.backupMaxBytes }),
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      // 큰 DR 상태 백업은 text/plain 원문으로 받는다(전역 JSON 파서 한도 우회).
      const blob =
        typeof req.body === "string"
          ? req.body
          : backupBodySchema.parse(req.body).blob;
      if (blob.length === 0) {
        throw AppError.badRequest("INVALID_BACKUP", "Backup blob is empty");
      }
      if (Buffer.byteLength(blob, "utf8") > config.backupMaxBytes) {
        throw AppError.payloadTooLarge(
          `Key backup exceeds ${config.backupMaxBytes} bytes`,
        );
      }
      const result = await upsertKeyBackup(db, {
        userId: auth.userId,
        deviceId: auth.deviceId,
        blob,
      });
      res.json({ updatedAt: result.updatedAt.toISOString() });
    }),
  );

  router.get(
    "/backup",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const backup = await getKeyBackupForDevice(db, auth.deviceId);
      if (!backup) {
        throw AppError.notFound("BACKUP_NOT_FOUND", "No key backup for this device");
      }
      res.json({
        backup: { blob: backup.blob, updatedAt: backup.updatedAt.toISOString() },
      });
    }),
  );

  router.post(
    "/recovery/lookup",
    recoveryLimiter,
    asyncHandler(async (req, res) => {
      const body = recoveryLookupBodySchema.parse(req.body);
      const backup = await findLatestBackupByUsername(db, body.username);
      if (!backup) {
        throw AppError.notFound("BACKUP_NOT_FOUND", "No key backup found");
      }
      res.json({
        backup: { blob: backup.blob, updatedAt: backup.updatedAt.toISOString() },
      });
    }),
  );

  router.post(
    "/recovery/challenge",
    recoveryLimiter,
    asyncHandler(async (req, res) => {
      const body = recoveryChallengeBodySchema.parse(req.body);
      const challenge = await createRecoveryChallenge(db, {
        deviceId: body.deviceId,
        ttlSeconds: config.recoveryChallengeTtlSeconds,
      });
      if (!challenge) {
        throw AppError.notFound(
          "RECOVERY_UNAVAILABLE",
          "Recovery is not available for this device",
        );
      }
      res.json({
        challengeId: challenge.challengeId,
        challenge: challenge.challenge,
        expiresAt: challenge.expiresAt.toISOString(),
      });
    }),
  );

  router.post(
    "/recover",
    recoveryLimiter,
    asyncHandler(async (req, res) => {
      const body = recoverBodySchema.parse(req.body);
      const consumed = await consumeRecoveryChallenge(db, {
        challengeId: body.challengeId,
        deviceId: body.deviceId,
      });
      if (!consumed) {
        throw AppError.badRequest(
          "RECOVERY_CHALLENGE_INVALID",
          "Recovery challenge expired or already used",
        );
      }

      const device = await findDeviceForRecovery(db, body.deviceId);
      if (!device) throw AppError.unauthorized("Device revoked or unknown");

      const valid = verifyEd25519Signature(
        device.signingPublicKey,
        Buffer.from(`recover:${consumed.nonce}`, "utf8"),
        body.signature,
      );
      if (!valid) throw AppError.unauthorized("Invalid recovery signature");

      const user = await findUserById(db, device.userId);
      if (!user || user.deletedAt !== null) {
        throw AppError.unauthorized("Unknown account");
      }

      // 복구한 기기의 기존 세션은 모두 폐기한다(다른 브라우저 로그아웃).
      await deleteSessionsForDevice(db, device.id);

      const issued = await issueSession(db, config, {
        userId: user.id,
        deviceId: device.id,
        userAgent: userAgent(req),
      });
      await recordAuthEvent(db, {
        userId: user.id,
        deviceId: device.id,
        event: "recover",
        ip: req.ip ?? null,
        userAgent: userAgent(req),
      });
      res.cookie(SESSION_COOKIE, issued.token, sessionCookieOptions(config));
      res.json({
        user: authUser(user),
        device: toPublicDevice(device),
        csrfToken: issued.csrfToken,
        expiresAt: issued.expiresAt.toISOString(),
        idleTimeoutSeconds: device.idleTimeoutSeconds,
        theme: toThemeSettings(user),
        hasPassword: user.passwordHash !== null,
        googleLinked: user.oauthSubject !== null,
      });
    }),
  );

  router.post(
    "/logout",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      await recordAuthEvent(db, {
        userId: auth.userId,
        deviceId: auth.deviceId,
        event: "logout",
        ip: req.ip ?? null,
        userAgent: userAgent(req),
      });
      await deleteSession(db, auth.sessionId);
      await removePushSubscriptionsForDevice(db, auth.deviceId);
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

  router.put(
    "/session/timeout",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = updateSessionIdleTimeoutBodySchema.parse(req.body);
      const updated = await updateSessionIdleTimeout(db, {
        sessionId: auth.sessionId,
        seconds: body.seconds,
      });
      res.json({
        sessionId: updated.id,
        idleTimeoutSeconds: updated.idleTimeoutSeconds,
      });
    }),
  );

  router.put(
    "/theme",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = updateThemeBodySchema.parse(req.body);
      const user = await updateUserTheme(db, {
        userId: auth.userId,
        mode: body.mode,
        accent: body.accent,
      });
      res.json({ theme: toThemeSettings(user) });
    }),
  );

  router.put(
    "/profile",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = updateProfileBodySchema.parse(req.body);
      const user = await updateUserStatus(db, {
        userId: auth.userId,
        statusMessage: body.statusMessage,
      });
      res.json({ user: authUser(user) });
    }),
  );

  /**
   * 공개 프로필 아바타 업로드.
   * 상태 메시지와 같은 공개 메타데이터라 암호화하지 않고, 크기·형식만 제한한다.
   */
  router.put(
    "/profile/avatar",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = updateAvatarBodySchema.parse(req.body);
      await setUserAvatar(db, { userId: auth.userId, mime: body.mime, dataBase64: body.data });
      const user = await findUserById(db, auth.userId);
      if (!user) throw AppError.unauthorized();
      res.json({ user: authUser(user) });
    }),
  );

  router.delete(
    "/profile/avatar",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      await clearUserAvatar(db, { userId: auth.userId });
      const user = await findUserById(db, auth.userId);
      if (!user) throw AppError.unauthorized();
      res.json({ user: authUser(user) });
    }),
  );

  /**
   * 마지막 접속 시각 공개 여부(옵트인).
   * 기본은 비공개이며, 켜면 대화 상대에게 `peer.lastSeenAt` 이 노출된다.
   */
  router.put(
    "/profile/last-seen",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = updateLastSeenBodySchema.parse(req.body);
      const user = await updateLastSeenVisibility(db, {
        userId: auth.userId,
        visible: body.visible,
      });
      res.json({ user: authUser(user) });
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
      const currentDevice = devices.find((device) => device.id === auth.deviceId);
      const deviceIdleTimeoutSeconds =
        currentDevice?.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
      res.json({
        user: authUser(user),
        deviceId: auth.deviceId,
        devices: devices.map(toOwnDevice),
        // 세션 오버라이드가 있으면 우선한다.
        idleTimeoutSeconds: auth.sessionIdleTimeoutSeconds ?? deviceIdleTimeoutSeconds,
        deviceIdleTimeoutSeconds,
        sessionIdleTimeoutSeconds: auth.sessionIdleTimeoutSeconds,
        theme: toThemeSettings(user),
        csrfToken: deriveCsrfToken(auth.sessionToken, config.sessionSecret),
        // 소셜 로그인/연결 상태(클라이언트가 버튼 노출·해제 가능 여부를 판단한다).
        oauthEnabled: config.googleOAuth !== null,
        googleLinked: user.oauthSubject !== null,
        hasPassword: user.passwordHash !== null,
      });
    }),
  );

  return router;
}
