import { z } from "zod";

const DEVELOPMENT_SESSION_SECRET =
  "onemoments-development-only-session-secret-do-not-use";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(["disable", "require", "verify-full"]).default("disable"),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  SESSION_SECRET: z.string().min(32).optional(),
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(60 * 60 * 24 * 30)
    .default(43200),
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  CORS_ORIGINS: z.string().default(""),
  MAX_CIPHERTEXT_BYTES: z.coerce.number().int().min(1024).max(1024 * 1024).default(16384),
  MAX_ENVELOPES: z.coerce.number().int().min(2).max(200).default(50),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(600000),
  MESSAGE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  MESSAGE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  SEARCH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  SEARCH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  METRICS_TOKEN: z.string().min(16).optional(),
  REDIS_URL: z.string().url().optional(),
  REDIS_CHANNEL: z.string().min(1).default("onemoments:events"),
  BACKUP_MAX_BYTES: z.coerce.number().int().min(1024).max(65536).default(16384),
  RECOVERY_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  ATTACHMENT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(25 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  ATTACHMENT_DIR: z.string().min(1).default("./data/attachments"),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
});

export interface Config {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  databaseSsl: "disable" | "require" | "verify-full";
  dbPoolMax: number;
  sessionSecret: string;
  sessionTtlSeconds: number;
  cookieSecure: boolean;
  corsOrigins: string[];
  maxCiphertextBytes: number;
  maxEnvelopes: number;
  authRateLimitMax: number;
  authRateLimitWindowMs: number;
  messageRateLimitMax: number;
  messageRateLimitWindowMs: number;
  searchRateLimitMax: number;
  searchRateLimitWindowMs: number;
  metricsToken: string | null;
  redisUrl: string | null;
  redisChannel: string;
  backupMaxBytes: number;
  recoveryChallengeTtlSeconds: number;
  attachmentMaxBytes: number;
  attachmentDir: string;
  trustProxy: number;
}

export type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${detail}`);
  }

  const value = parsed.data;
  let sessionSecret = value.SESSION_SECRET;
  if (!sessionSecret) {
    if (value.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET (>= 32 chars) is required when NODE_ENV=production");
    }
    sessionSecret = DEVELOPMENT_SESSION_SECRET;
  }

  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    databaseSsl: value.DATABASE_SSL,
    dbPoolMax: value.DB_POOL_MAX,
    sessionSecret,
    sessionTtlSeconds: value.SESSION_TTL_SECONDS,
    cookieSecure: value.COOKIE_SECURE
      ? value.COOKIE_SECURE === "true"
      : value.NODE_ENV === "production",
    corsOrigins: value.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    maxCiphertextBytes: value.MAX_CIPHERTEXT_BYTES,
    maxEnvelopes: value.MAX_ENVELOPES,
    authRateLimitMax: value.AUTH_RATE_LIMIT_MAX,
    authRateLimitWindowMs: value.AUTH_RATE_LIMIT_WINDOW_MS,
    messageRateLimitMax: value.MESSAGE_RATE_LIMIT_MAX,
    messageRateLimitWindowMs: value.MESSAGE_RATE_LIMIT_WINDOW_MS,
    searchRateLimitMax: value.SEARCH_RATE_LIMIT_MAX,
    searchRateLimitWindowMs: value.SEARCH_RATE_LIMIT_WINDOW_MS,
    metricsToken: value.METRICS_TOKEN ?? null,
    redisUrl: value.REDIS_URL ?? null,
    redisChannel: value.REDIS_CHANNEL,
    backupMaxBytes: value.BACKUP_MAX_BYTES,
    recoveryChallengeTtlSeconds: value.RECOVERY_CHALLENGE_TTL_SECONDS,
    attachmentMaxBytes: value.ATTACHMENT_MAX_BYTES,
    attachmentDir: value.ATTACHMENT_DIR,
    trustProxy: value.TRUST_PROXY,
  };
}
