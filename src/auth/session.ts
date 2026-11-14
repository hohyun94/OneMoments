import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { Config } from "../config.js";

export const SESSION_COOKIE = "om_session";
export const CSRF_HEADER = "x-csrf-token";

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** DB 에는 원문 토큰 대신 SHA-256 해시만 저장한다. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * CSRF 토큰은 세션 토큰에서 HMAC 으로 파생한다.
 * HttpOnly 쿠키를 읽을 수 없는 스크립트는 올바른 헤더 값을 만들 수 없다.
 */
export function deriveCsrfToken(sessionToken: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionToken}`, "utf8").digest("base64url");
}

export function verifyCsrfToken(
  supplied: string,
  sessionToken: string,
  secret: string,
): boolean {
  const expected = deriveCsrfToken(sessionToken, secret);
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function sessionCookieOptions(config: Config) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: config.sessionTtlSeconds * 1000,
  };
}

export function clearSessionCookieOptions(config: Config) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax" as const,
    path: "/",
  };
}
