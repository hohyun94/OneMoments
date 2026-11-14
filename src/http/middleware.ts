import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { devices, sessions, users } from "../db/schema.js";
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  hashSessionToken,
  verifyCsrfToken,
} from "../auth/session.js";
import { AppError } from "./errors.js";

export interface AuthContext {
  userId: string;
  username: string;
  deviceId: string;
  sessionId: string;
  sessionToken: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth;
}

const LAST_SEEN_UPDATE_MS = 60_000;

/**
 * 세션 쿠키 → DB 세션 조회. 만료·폐기 기기·삭제 계정은 인정하지 않는다.
 * 부수 효과로 last_seen_at 을 60초에 한 번만 갱신한다.
 */
export async function resolveSession(
  db: Database,
  token: string,
): Promise<AuthContext | null> {
  const tokenHash = hashSessionToken(token);
  const [row] = await db
    .select({
      session: sessions,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(devices, eq(devices.id, sessions.deviceId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        gt(sessions.expiresAt, new Date()),
        isNull(users.deletedAt),
        isNull(devices.revokedAt),
        eq(devices.userId, users.id),
      ),
    )
    .limit(1);

  if (!row) return null;

  const cutoff = new Date(Date.now() - LAST_SEEN_UPDATE_MS);
  if (row.session.lastSeenAt < cutoff) {
    void db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(sessions.id, row.session.id), lt(sessions.lastSeenAt, cutoff)))
      .catch(() => undefined);
  }

  return {
    userId: row.user.id,
    username: row.user.username,
    deviceId: row.session.deviceId,
    sessionId: row.session.id,
    sessionToken: token,
  };
}

export function requireSession(db: Database): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== "string" || token.length === 0) {
      next(AppError.unauthorized());
      return;
    }
    resolveSession(db, token)
      .then((auth) => {
        if (!auth) {
          next(AppError.unauthorized("Session expired or invalid"));
          return;
        }
        req.auth = auth;
        next();
      })
      .catch(next);
  };
}

/** 쿠키 기반 세션에서 CSRF 헤더를 검증한다. 상태 변경 요청에만 적용한다. */
export function requireCsrf(config: Config): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) {
      next(AppError.unauthorized());
      return;
    }
    const supplied = req.header(CSRF_HEADER);
    if (
      !supplied ||
      !verifyCsrfToken(supplied, auth.sessionToken, config.sessionSecret)
    ) {
      next(AppError.forbidden("Invalid CSRF token"));
      return;
    }
    next();
  };
}

/** Origin 이 있으면 허용 목록(또는 동일 호스트)에 속해야 한다. */
export function originGuard(config: Config): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    if (config.corsOrigins.includes(origin)) {
      next();
      return;
    }
    try {
      if (new URL(origin).host === req.headers.host) {
        next();
        return;
      }
    } catch {
      // 잘못된 Origin 헤더는 거절한다.
    }
    next(AppError.forbidden("Origin not allowed"));
  };
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  key: (req: Request) => string;
  message?: string;
}

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, _res: Response, next: NextFunction) => {
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }

    const key = options.key(req);
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    if (bucket.count >= options.max) {
      next(AppError.tooManyRequests(options.message));
      return;
    }
    bucket.count += 1;
    next();
  };
}
