import { createServer } from "node:http";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createApp } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import { createDb, type Database } from "../../src/db/client.js";
import { LocalMessageBus } from "../../src/realtime/bus.js";
import { createRealtime, type RealtimeHandle } from "../../src/realtime/ws.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://onemoments:onemoments@127.0.0.1:55432/onemoments_test";

const TEST_SESSION_SECRET = "test-session-secret-0123456789abcdef012345";

export interface TestContext {
  config: Config;
  db: Database;
  baseUrl: string;
  wsUrl: string;
  realtime: RealtimeHandle;
  close: () => Promise<void>;
}

export interface TestContextOptions {
  /** ADMIN_USERNAMES allowlist (테스트용) */
  adminUsernames?: string[];
  /** 가입 정책(기본 open). invite/closed 동작을 검증할 때 넘긴다. */
  signupMode?: "open" | "invite" | "closed";
  /** 스텁 IdP 를 붙일 때 넘긴다. 넘기면 Google OAuth 가 활성화된다. */
  googleOAuth?: {
    authorizeUrl: string;
    tokenUrl: string;
    userInfoUrl: string;
    clientId?: string;
    clientSecret?: string;
    redirectUrl?: string;
    appOrigin?: string;
  };
}

export async function createTestContext(
  options: TestContextOptions = {},
): Promise<TestContext> {
  const { db, pool } = createDb({
    databaseUrl: TEST_DATABASE_URL,
    databaseSsl: "disable",
    dbPoolMax: 4,
  });

  try {
    await migrate(db, {
      migrationsFolder: "drizzle/postgres-migrations",
      migrationsTable: "__onemoments_migrations",
    });
  } catch (error) {
    const redacted = TEST_DATABASE_URL.replace(/\/\/[^@/]*@/, "//***@");
    throw new Error(
      `테스트 DB에 연결할 수 없습니다 (${redacted}). TEST_DATABASE_URL 을 지정하거나 ` +
        "`docker compose -f docker-compose.db.yml up -d` 후 " +
        "`CREATE DATABASE onemoments_test` 를 실행하세요.",
      { cause: error },
    );
  }

  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "3000",
    DATABASE_URL: TEST_DATABASE_URL,
    SESSION_SECRET: TEST_SESSION_SECRET,
    SESSION_TTL_SECONDS: "3600",
    COOKIE_SECURE: "false",
    MAX_CIPHERTEXT_BYTES: "16384",
    MAX_ENVELOPES: "50",
    AUTH_RATE_LIMIT_MAX: "1000",
    MESSAGE_RATE_LIMIT_MAX: "10000",
    SEARCH_RATE_LIMIT_MAX: "10000",
    ATTACHMENT_MAX_BYTES: "4096",
    ATTACHMENT_DIR: ".test-artifacts/attachments",
    METRICS_TOKEN: "test-metrics-token-0123456789",
    ADMIN_USERNAMES: (options.adminUsernames ?? []).join(","),
    SIGNUP_MODE: options.signupMode ?? "open",
    ...(options.googleOAuth
      ? {
          GOOGLE_CLIENT_ID: options.googleOAuth.clientId ?? "test-google-client",
          GOOGLE_CLIENT_SECRET: options.googleOAuth.clientSecret ?? "test-google-secret",
          GOOGLE_REDIRECT_URL:
            options.googleOAuth.redirectUrl ??
            "http://127.0.0.1:3000/api/auth/google/callback",
          APP_ORIGIN: options.googleOAuth.appOrigin ?? "http://127.0.0.1:3000",
          GOOGLE_AUTHORIZE_URL: options.googleOAuth.authorizeUrl,
          GOOGLE_TOKEN_URL: options.googleOAuth.tokenUrl,
          GOOGLE_USERINFO_URL: options.googleOAuth.userInfoUrl,
        }
      : {}),
  });

  const bus = new LocalMessageBus();
  const app = createApp({ db, config, bus });
  const server = createServer(app);
  const realtime = createRealtime({ server, db, config, bus });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    config,
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    realtime,
    close: async () => {
      await realtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

export async function resetDatabase(db: Database): Promise<void> {
  await db.execute(
    sql`truncate table message_deletions, user_blocks, user_favorites, moment_views, moment_keys, moment_audience, moment_attachments, moments, message_reads, message_keys, messages, conversation_participants, conversations, sessions, devices, users restart identity cascade`,
  );
}
