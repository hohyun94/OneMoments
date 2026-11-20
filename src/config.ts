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
  // 관리자 콘솔 권한 allowlist. 비어 있으면 관리자 기능이 비활성화된다.
  ADMIN_USERNAMES: z.string().default(""),
  MAX_CIPHERTEXT_BYTES: z.coerce.number().int().min(1024).max(1024 * 1024).default(16384),
  MAX_ENVELOPES: z.coerce.number().int().min(2).max(200).default(50),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(600000),
  MESSAGE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  MESSAGE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  SEARCH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  SEARCH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
  METRICS_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(16).optional(),
  ),
  REDIS_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
  REDIS_CHANNEL: z.string().min(1).default("onemoments:events"),
  BACKUP_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(25 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  RECOVERY_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  ATTACHMENT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(25 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  ATTACHMENT_DIR: z.string().min(1).default("./data/attachments"),
  ATTACHMENT_STORAGE: z.enum(["local", "s3"]).default("local"),
  ATTACHMENT_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  S3_BUCKET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ENDPOINT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
  S3_ACCESS_KEY_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  S3_SECRET_ACCESS_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  VAPID_PUBLIC_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  VAPID_PRIVATE_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  VAPID_SUBJECT: z.string().min(1).default("mailto:admin@example.com"),
  PUSH_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  // Google OAuth(가입·로그인·계정 연결). CLIENT_ID/SECRET/REDIRECT_URL 이 모두 있어야 활성화된다.
  GOOGLE_CLIENT_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  GOOGLE_CLIENT_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  GOOGLE_REDIRECT_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
  /** OAuth 완료 후 돌아갈 SPA 주소. 기본값은 REDIRECT_URL 의 origin. */
  APP_ORIGIN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
  // 테스트/자체 IdP 용 엔드포인트 오버라이드. 비우면 Google 실제 주소를 쓴다.
  GOOGLE_AUTHORIZE_URL: z.string().url().default("https://accounts.google.com/o/oauth2/v2/auth"),
  GOOGLE_TOKEN_URL: z.string().url().default("https://oauth2.googleapis.com/token"),
  GOOGLE_USERINFO_URL: z.string().url().default("https://openidconnect.googleapis.com/v1/userinfo"),
  OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
  OAUTH_TICKET_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
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
  adminUsernames: string[];
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
  attachmentStorage: "local" | "s3";
  attachmentTtlDays: number;
  s3Bucket: string | null;
  s3Region: string;
  s3Endpoint: string | null;
  s3AccessKeyId: string | null;
  s3SecretAccessKey: string | null;
  s3ForcePathStyle: boolean;
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  vapidSubject: string;
  pushTtlSeconds: number;
  trustProxy: number;
  /** Google OAuth 설정. null 이면 소셜 로그인이 비활성화된다. */
  googleOAuth: GoogleOAuthConfig | null;
  oauthStateTtlSeconds: number;
  oauthTicketTtlSeconds: number;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Google 콘솔에 등록한 서버 콜백 주소. */
  redirectUrl: string;
  /** OAuth 완료 후 SPA 로 돌려보낼 origin. */
  appOrigin: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
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
  if (Boolean(value.VAPID_PUBLIC_KEY) !== Boolean(value.VAPID_PRIVATE_KEY)) {
    throw new Error("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together");
  }
  if (value.ATTACHMENT_STORAGE === "s3" && !value.S3_BUCKET) {
    throw new Error("S3_BUCKET is required when ATTACHMENT_STORAGE=s3");
  }
  if (Boolean(value.S3_ACCESS_KEY_ID) !== Boolean(value.S3_SECRET_ACCESS_KEY)) {
    throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together");
  }
  if (!/^(mailto:|https:\/\/)/.test(value.VAPID_SUBJECT)) {
    throw new Error("VAPID_SUBJECT must start with mailto: or https://");
  }
  let sessionSecret = value.SESSION_SECRET;
  if (!sessionSecret) {
    if (value.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET (>= 32 chars) is required when NODE_ENV=production");
    }
    sessionSecret = DEVELOPMENT_SESSION_SECRET;
  }

  const googleConfigured = [value.GOOGLE_CLIENT_ID, value.GOOGLE_CLIENT_SECRET, value.GOOGLE_REDIRECT_URL];
  const googlePartial = googleConfigured.some(Boolean) && !googleConfigured.every(Boolean);
  if (googlePartial) {
    throw new Error(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URL must be set together",
    );
  }
  const googleOAuth: GoogleOAuthConfig | null =
    value.GOOGLE_CLIENT_ID && value.GOOGLE_CLIENT_SECRET && value.GOOGLE_REDIRECT_URL
      ? {
          clientId: value.GOOGLE_CLIENT_ID,
          clientSecret: value.GOOGLE_CLIENT_SECRET,
          redirectUrl: value.GOOGLE_REDIRECT_URL,
          appOrigin: value.APP_ORIGIN ?? new URL(value.GOOGLE_REDIRECT_URL).origin,
          authorizeUrl: value.GOOGLE_AUTHORIZE_URL,
          tokenUrl: value.GOOGLE_TOKEN_URL,
          userInfoUrl: value.GOOGLE_USERINFO_URL,
        }
      : null;

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
    adminUsernames: value.ADMIN_USERNAMES.split(",")
      .map((username) => username.trim().toLowerCase())
      .filter((username) => username.length > 0),
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
    attachmentStorage: value.ATTACHMENT_STORAGE,
    attachmentTtlDays: value.ATTACHMENT_TTL_DAYS,
    s3Bucket: value.S3_BUCKET ?? null,
    s3Region: value.S3_REGION,
    s3Endpoint: value.S3_ENDPOINT ?? null,
    s3AccessKeyId: value.S3_ACCESS_KEY_ID ?? null,
    s3SecretAccessKey: value.S3_SECRET_ACCESS_KEY ?? null,
    s3ForcePathStyle: value.S3_FORCE_PATH_STYLE === "true",
    vapidPublicKey: value.VAPID_PUBLIC_KEY ?? null,
    vapidPrivateKey: value.VAPID_PRIVATE_KEY ?? null,
    vapidSubject: value.VAPID_SUBJECT,
    pushTtlSeconds: value.PUSH_TTL_SECONDS,
    trustProxy: value.TRUST_PROXY,
    googleOAuth,
    oauthStateTtlSeconds: value.OAUTH_STATE_TTL_SECONDS,
    oauthTicketTtlSeconds: value.OAUTH_TICKET_TTL_SECONDS,
  };
}
