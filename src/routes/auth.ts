import express, { Router, type Request } from "express";

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
import { AppError, asyncHandler } from "../http/errors.js";
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
} from "../http/validation.js";
import {
  deleteAccount,
  deleteSession,
  deleteSessionsForDevice,
  findActiveDevice,
  findUserById,
  listDevices,
  registerAccount,
  registerDevice,
  updateDeviceSignedPreKey,
  verifyCredentials,
} from "../services/accounts.js";
import {
  consumeRecoveryChallenge,
  createRecoveryChallenge,
  findDeviceForRecovery,
  findLatestBackupByUsername,
  getKeyBackupForDevice,
  upsertKeyBackup,
} from "../services/keyBackup.js";

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
      res.cookie(SESSION_COOKIE, issued.token, sessionCookieOptions(config));
      res.json({
        user: toPublicUser(user),
        device: toPublicDevice(device),
        csrfToken: issued.csrfToken,
        expiresAt: issued.expiresAt.toISOString(),
      });
    }),
  );

  router.post(
    "/logout",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
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
