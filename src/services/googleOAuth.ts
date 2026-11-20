import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, gt, lt } from "drizzle-orm";

import type { GoogleOAuthConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { oauthStates, oauthTickets, type OAuthTicketRow } from "../db/schema.js";
import { AppError } from "../http/errors.js";

/** OAuth 진행 의도. signup=새 계정, login=기존 연결 계정, link=로그인 상태에서 연결. */
export type OAuthIntent = "signup" | "login" | "link";

export const OAUTH_PROVIDER = "google";
/** state 를 브라우저에 묶어 두는 단명 쿠키(로그인 CSRF 방지). */
export const OAUTH_STATE_COOKIE = "om_oauth_state";
const MAX_PROVIDER_TIMEOUT_MS = 10_000;

export interface GoogleProfile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/** state 원문은 저장하지 않고 SHA-256 해시만 둔다. */
export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/** 길이가 다른 값을 거부하는 상수 시간 비교. */
export function safeStateEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** RFC 7636 S256 PKCE. verifier 는 DB 에만, challenge 는 Google 에게만 보낸다. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizationUrl(
  config: GoogleOAuthConfig,
  input: { state: string; challenge: string },
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  // 매번 계정을 고르게 해 공용 기기에서 이전 계정으로 자동 로그인되지 않게 한다.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function createOAuthState(
  db: Database,
  input: {
    config: GoogleOAuthConfig;
    intent: OAuthIntent;
    userId?: string | null;
    ttlSeconds: number;
  },
): Promise<{ state: string; authorizationUrl: string }> {
  const state = base64Url(randomBytes(32));
  const pkce = createPkcePair();
  await db.insert(oauthStates).values({
    stateHash: hashOAuthState(state),
    provider: OAUTH_PROVIDER,
    intent: input.intent,
    codeVerifier: pkce.verifier,
    userId: input.userId ?? null,
    expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
  });
  return {
    state,
    authorizationUrl: buildAuthorizationUrl(input.config, {
      state,
      challenge: pkce.challenge,
    }),
  };
}

/** state 를 1회 소비한다(만료·재사용 불가). */
export async function consumeOAuthState(
  db: Database,
  state: string,
): Promise<{ intent: OAuthIntent; codeVerifier: string; userId: string | null } | null> {
  const [row] = await db
    .delete(oauthStates)
    .where(
      and(
        eq(oauthStates.stateHash, hashOAuthState(state)),
        gt(oauthStates.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!row) return null;
  return {
    intent: row.intent as OAuthIntent,
    codeVerifier: row.codeVerifier,
    userId: row.userId,
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  failure: () => AppError,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(MAX_PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw failure();
  }
  if (!response.ok) throw failure();
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw failure();
  }
  if (!parsed || typeof parsed !== "object") throw failure();
  return parsed as Record<string, unknown>;
}

/**
 * 인가 코드를 토큰으로 교환하고 사용자 정보를 읽는다.
 * 서버가 client_secret 으로 직접 교환하므로 받은 access_token 은 우리 클라이언트 발급임이 보장된다.
 */
export async function exchangeGoogleCode(
  config: GoogleOAuthConfig,
  input: { code: string; codeVerifier: string },
): Promise<GoogleProfile> {
  const tokens = await fetchJson(
    config.tokenUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        code: input.code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUrl,
        grant_type: "authorization_code",
        code_verifier: input.codeVerifier,
      }).toString(),
    },
    () => AppError.badRequest("OAUTH_EXCHANGE_FAILED", "Google token exchange failed"),
  );

  const accessToken = tokens.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw AppError.badRequest("OAUTH_EXCHANGE_FAILED", "Google token exchange failed");
  }

  const info = await fetchJson(
    config.userInfoUrl,
    { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } },
    () => AppError.badRequest("OAUTH_USERINFO_FAILED", "Google profile request failed"),
  );

  if (typeof info.sub !== "string" || info.sub.length === 0) {
    throw AppError.badRequest("OAUTH_USERINFO_INVALID", "Google profile has no subject");
  }
  return {
    subject: info.sub,
    email: typeof info.email === "string" ? info.email : null,
    emailVerified: info.email_verified === true,
  };
}

export async function createOAuthTicket(
  db: Database,
  input: {
    profile: GoogleProfile;
    intent: OAuthIntent;
    userId?: string | null;
    ttlSeconds: number;
  },
): Promise<OAuthTicketRow> {
  const [row] = await db
    .insert(oauthTickets)
    .values({
      provider: OAUTH_PROVIDER,
      subject: input.profile.subject,
      email: input.profile.email,
      emailVerified: input.profile.emailVerified,
      intent: input.intent,
      userId: input.userId ?? null,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    })
    .returning();
  if (!row) throw new Error("Failed to create oauth ticket");
  return row;
}

/** 티켓을 1회 소비한다(만료·재사용 불가). */
export async function consumeOAuthTicket(
  db: Database,
  ticketId: string,
): Promise<OAuthTicketRow | null> {
  const [row] = await db
    .delete(oauthTickets)
    .where(and(eq(oauthTickets.id, ticketId), gt(oauthTickets.expiresAt, new Date())))
    .returning();
  return row ?? null;
}

/** 만료된 state·ticket 을 정리한다(호출 빈도는 운영 판단). */
export async function cleanupOAuthArtifacts(db: Database): Promise<void> {
  const now = new Date();
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now));
  await db.delete(oauthTickets).where(lt(oauthTickets.expiresAt, now));
}

