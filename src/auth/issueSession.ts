import { deriveCsrfToken, generateSessionToken, hashSessionToken } from "./session.js";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { createSession } from "../services/accounts.js";

export interface IssuedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function issueSession(
  db: Database,
  config: Config,
  input: { userId: string; deviceId: string; userAgent: string | null },
): Promise<IssuedSession> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);
  await createSession(db, {
    userId: input.userId,
    deviceId: input.deviceId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    userAgent: input.userAgent,
  });
  return {
    token,
    csrfToken: deriveCsrfToken(token, config.sessionSecret),
    expiresAt,
  };
}
