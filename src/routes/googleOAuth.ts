import { Router, type Request, type Response } from "express";

import { isAdminUsername } from "../auth/admin.js";
import { issueSession, type IssuedSession } from "../auth/issueSession.js";
import { SESSION_COOKIE, sessionCookieOptions } from "../auth/session.js";
import type { Config, GoogleOAuthConfig } from "../config.js";
import { normalizeDeviceKeys } from "../crypto/envelope.js";
import type { Database } from "../db/client.js";
import type { DeviceRow, UserRow } from "../db/schema.js";
import { AppError, asyncHandler } from "../http/errors.js";
import {
  createRateLimiter,
  getAuth,
  requireCsrf,
  requireSession,
} from "../http/middleware.js";
import { toPublicDevice, toPublicUser } from "../http/serializers.js";
import {
  googleOAuthCallbackQuerySchema,
  googleOAuthCompleteBodySchema,
  googleOAuthStartBodySchema,
  googleOAuthUnlinkBodySchema,
} from "../http/validation.js";
import {
  deleteSessionsForDevice,
  findUserById,
  findUserByOAuthSubject,
  linkOAuthAccount,
  registerDevice,
  registerOAuthAccount,
  unlinkOAuthAccount,
} from "../services/accounts.js";
import { recordAuthEvent } from "../services/authEvents.js";
import {
  OAUTH_STATE_COOKIE,
  consumeOAuthState,
  consumeOAuthTicket,
  createOAuthState,
  createOAuthTicket,
  exchangeGoogleCode,
  safeStateEqual,
} from "../services/googleOAuth.js";
import { toThemeSettings } from "../services/theme.js";

const STATE_COOKIE_PATH = "/api/auth/google";

function requireGoogleOAuth(config: Config): GoogleOAuthConfig {
  if (!config.googleOAuth) {
    throw new AppError(503, "OAUTH_DISABLED", "Google sign-in is not configured");
  }
  return config.googleOAuth;
}

function stateCookieOptions(config: Config) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.cookieSecure,
    path: STATE_COOKIE_PATH,
    maxAge: config.oauthStateTtlSeconds * 1000,
  };
}

function userAgent(req: Request): string | null {
  return req.header("user-agent") ?? null;
}

function appRedirect(config: GoogleOAuthConfig, params: Record<string, string>): string {
  const url = new URL("/oauth/callback", config.appOrigin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export function createGoogleOAuthRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);
  const csrf = requireCsrf(config);
  const limiter = createRateLimiter({
    windowMs: config.authRateLimitWindowMs,
    max: config.authRateLimitMax,
    key: (req) => req.ip ?? "unknown",
    message: "Too many authentication attempts",
  });

  const authPayload = (
    user: UserRow,
    device: DeviceRow,
    issued: IssuedSession,
  ): Record<string, unknown> => ({
    user: { ...toPublicUser(user), isAdmin: isAdminUsername(config, user.username) },
    device: toPublicDevice(device),
    csrfToken: issued.csrfToken,
    expiresAt: issued.expiresAt.toISOString(),
    idleTimeoutSeconds: device.idleTimeoutSeconds,
    theme: toThemeSettings(user),
    hasPassword: user.passwordHash !== null,
    googleLinked: user.oauthSubject !== null,
  });

  const sendSignIn = (
    res: Response,
    user: UserRow,
    device: DeviceRow,
    issued: IssuedSession,
    status: number,
  ): void => {
    res.cookie(SESSION_COOKIE, issued.token, sessionCookieOptions(config));
    res.status(status).json(authPayload(user, device, issued));
  };

  /** 익명 시작(가입/로그인). state 는 HttpOnly 쿠키로 브라우저에 묶는다. */
  router.post(
    "/start",
    limiter,
    asyncHandler(async (req, res) => {
      const oauth = requireGoogleOAuth(config);
      const body = googleOAuthStartBodySchema.parse(req.body);
      if (body.intent === "link") {
        throw AppError.badRequest(
          "OAUTH_INTENT_INVALID",
          "Use /api/auth/google/start/link to link while signed in",
        );
      }
      // 초대제/가입 중지 모드에서는 Google 신규 가입을 허용하지 않는다(초대 코드 우회 방지).
      if (body.intent === "signup" && config.signupMode !== "open") {
        throw AppError.forbidden("초대 코드로만 가입할 수 있습니다.");
      }
      const created = await createOAuthState(db, {
        config: oauth,
        intent: body.intent,
        ttlSeconds: config.oauthStateTtlSeconds,
      });
      res.cookie(OAUTH_STATE_COOKIE, created.state, stateCookieOptions(config));
      res.json({ authorizationUrl: created.authorizationUrl });
    }),
  );

  /** 로그인 상태에서 계정 연결 시작(세션 + CSRF 필요). */
  router.post(
    "/start/link",
    limiter,
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const oauth = requireGoogleOAuth(config);
      const auth = getAuth(req);
      const created = await createOAuthState(db, {
        config: oauth,
        intent: "link",
        userId: auth.userId,
        ttlSeconds: config.oauthStateTtlSeconds,
      });
      res.cookie(OAUTH_STATE_COOKIE, created.state, stateCookieOptions(config));
      res.json({ authorizationUrl: created.authorizationUrl });
    }),
  );
  /** Google 콜백. 성공하면 SPA 로 1회용 티켓을 넘긴다(여기서 세션을 발급하지 않는다). */
  router.get(
    "/callback",
    asyncHandler(async (req, res) => {
      const oauth = requireGoogleOAuth(config);
      const query = googleOAuthCallbackQuerySchema.parse(req.query);
      const cookieState: unknown = req.cookies?.[OAUTH_STATE_COOKIE];
      res.clearCookie(OAUTH_STATE_COOKIE, {
        httpOnly: true,
        sameSite: "lax",
        secure: config.cookieSecure,
        path: STATE_COOKIE_PATH,
      });

      const fail = (reason: string) => {
        res.redirect(302, appRedirect(oauth, { oauth_error: reason }));
      };

      if (query.error) {
        fail(query.error === "access_denied" ? "access_denied" : "provider_error");
        return;
      }
      if (!query.code || !query.state) {
        fail("invalid_request");
        return;
      }
      // 로그인 CSRF: 브라우저에 심어 둔 state 와 콜백 state 가 같아야 한다.
      if (typeof cookieState !== "string" || !safeStateEqual(cookieState, query.state)) {
        fail("state_mismatch");
        return;
      }

      const stateRow = await consumeOAuthState(db, query.state);
      if (!stateRow) {
        fail("state_expired");
        return;
      }

      let profile;
      try {
        profile = await exchangeGoogleCode(oauth, {
          code: query.code,
          codeVerifier: stateRow.codeVerifier,
        });
      } catch {
        fail("provider_error");
        return;
      }
      if (!profile.emailVerified) {
        fail("email_unverified");
        return;
      }

      const linked = await findUserByOAuthSubject(db, {
        provider: "google",
        subject: profile.subject,
      });
      if (stateRow.intent === "signup" && linked) {
        fail("already_linked");
        return;
      }
      if (stateRow.intent === "login" && !linked) {
        fail("not_linked");
        return;
      }
      if (stateRow.intent === "link" && linked && linked.id !== stateRow.userId) {
        fail("already_linked");
        return;
      }

      const ticket = await createOAuthTicket(db, {
        profile,
        intent: stateRow.intent,
        userId: stateRow.intent === "signup" ? null : (linked?.id ?? stateRow.userId),
        ttlSeconds: config.oauthTicketTtlSeconds,
      });
      res.redirect(
        302,
        appRedirect(oauth, { oauth_ticket: ticket.id, oauth_intent: ticket.intent }),
      );
    }),
  );

  /** 가입/로그인 완료: 티켓 + (가입 시)아이디 + 기기 공개키로 세션을 발급한다. */
  router.post(
    "/complete",
    limiter,
    asyncHandler(async (req, res) => {
      requireGoogleOAuth(config);
      const body = googleOAuthCompleteBodySchema.parse(req.body);
      const ticket = await consumeOAuthTicket(db, body.ticket);
      if (!ticket) {
        throw AppError.badRequest("OAUTH_TICKET_INVALID", "Ticket is invalid or expired");
      }
      if (ticket.intent === "link") {
        throw AppError.badRequest(
          "OAUTH_INTENT_INVALID",
          "Use /api/auth/google/complete/link",
        );
      }
      if (!body.device) {
        throw AppError.badRequest("DEVICE_REQUIRED", "Device keys are required");
      }
      const keys = normalizeDeviceKeys(body.device);

      if (ticket.intent === "signup") {
        if (!body.username) {
          throw AppError.badRequest(
            "USERNAME_REQUIRED",
            "Choose a username to finish sign-up",
          );
        }
        const { user, device } = await registerOAuthAccount(db, {
          username: body.username,
          provider: "google",
          subject: ticket.subject,
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
        sendSignIn(res, user, device, issued, 201);
        return;
      }

      // login: 티켓이 가리키는 계정에 새 기기를 등록하고 세션을 발급한다.
      const user = ticket.userId ? await findUserById(db, ticket.userId) : null;
      if (!user || user.deletedAt !== null) throw AppError.unauthorized("Unknown account");
      const device = await registerDevice(db, {
        userId: user.id,
        name: body.device.name,
        platform: body.device.platform,
        ...keys,
      });
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
      sendSignIn(res, user, device, issued, 200);
    }),
  );

  /** 로그인 상태에서 계정 연결 완료(세션 + CSRF). 티켓은 같은 사용자 것이어야 한다. */
  router.post(
    "/complete/link",
    limiter,
    session,
    csrf,
    asyncHandler(async (req, res) => {
      requireGoogleOAuth(config);
      const auth = getAuth(req);
      const body = googleOAuthCompleteBodySchema.parse(req.body);
      const ticket = await consumeOAuthTicket(db, body.ticket);
      if (!ticket || ticket.intent !== "link" || ticket.userId !== auth.userId) {
        throw AppError.badRequest("OAUTH_TICKET_INVALID", "Ticket is invalid or expired");
      }
      const user = await linkOAuthAccount(db, {
        userId: auth.userId,
        provider: "google",
        subject: ticket.subject,
      });
      res.json({
        user: { ...toPublicUser(user), isAdmin: isAdminUsername(config, user.username) },
        hasPassword: user.passwordHash !== null,
        googleLinked: true,
      });
    }),
  );

  /** 연결 해제. 비밀번호가 없는 계정은 잠기므로 거부한다. */
  router.post(
    "/unlink",
    limiter,
    session,
    csrf,
    asyncHandler(async (req, res) => {
      requireGoogleOAuth(config);
      const auth = getAuth(req);
      const body = googleOAuthUnlinkBodySchema.parse(req.body);
      const user = await unlinkOAuthAccount(db, {
        userId: auth.userId,
        password: body.password,
      });
      res.json({
        user: { ...toPublicUser(user), isAdmin: isAdminUsername(config, user.username) },
        hasPassword: true,
        googleLinked: false,
      });
    }),
  );

  return router;
}
