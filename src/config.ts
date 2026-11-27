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
  // 가입 정책: open(누구나) / invite(초대 코드 필요) / closed(가입 중지)
  SIGNUP_MODE: z.enum(["open", "invite", "closed"]).default("open"),
  /**
   * 가입 신청(관리자 승인형) 허용 여부. 초대 코드 경로와 **함께** 켤 수 있다.
   * 승인되면 1회용 초대 코드가 발급되고, 신청자는 그 코드로 가입을 완료한다.
   */
  SIGNUP_REQUEST_ENABLED: z.enum(["true", "false"]).default("false"),
  // 링크 미리보기: 서버가 외부 OG 메타데이터를 대신 가져온다(SSRF 방어 적용).
  LINK_PREVIEW_ENABLED: z.enum(["true", "false"]).default("true"),
  // 지도 타일 템플릿(예: https://tile.openstreetmap.org/{z}/{x}/{y}.png).
  // 비어 있으면 위치 공유는 기존 좌표 카드만 쓰고, 지도 이미지 기능은 숨겨진다.
  MAP_TILE_URL: z
    .string()
    .default("")
    .refine(
      (value) => value === "" || /^https?:\/\/\S+$/.test(value),
      "MAP_TILE_URL must be an http(s) URL template",
    ),
  // 1:1 음성 통화(WebRTC). 시그널링은 기존 WS 로, 미디어는 P2P(불가 시 TURN) 로 흐른다.
  CALL_ENABLED: z.enum(["true", "false"]).default("true"),
  CALL_VIDEO_ENABLED: z.enum(["true", "false"]).default("true"),
  CALL_STUN_URLS: z.string().default(""),
  CALL_TURN_URLS: z.string().default(""),
  CALL_TURN_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(8).optional(),
  ),
  CALL_TURN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(600),
  CALL_RING_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
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
  /** 가입 정책(open/invite/closed). invite 면 관리자 발급 초대 코드가 필요하다. */
  signupMode: "open" | "invite" | "closed";
  /** 가입 신청(관리자 승인형) 허용 여부. 승인 시 1회용 초대 코드를 발급한다. */
  signupRequestEnabled: boolean;
  /** 링크 미리보기(서버가 외부 OG 메타데이터를 대신 가져옴) */
  linkPreviewEnabled: boolean;
  /** 지도 타일 템플릿(없으면 지도 이미지 기능 비활성). */
  mapTileUrl: string | null;
  /** CSP img-src 에 허용할 타일 오리진. */
  mapTileOrigin: string | null;
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
  /** 1:1 음성 통화 설정. enabled=false 면 UI·시그널링을 모두 막는다. */
  calls: CallConfig;
}

export interface CallConfig {
  enabled: boolean;
  /** 영상 통화 노출 여부. false 면 오디오만 제공한다. */
  videoEnabled: boolean;
  /** STUN 서버 URL 목록(stun:). 비어 있으면 호스트 후보만 사용한다. */
  stunUrls: string[];
  /** TURN 서버 URL 목록(turn:/turns:). */
  turnUrls: string[];
  /** coturn REST API 공유 비밀(시간 제한 자격증명 발급용). */
  turnSecret: string | null;
  /** TURN 자격증명 유효 시간(초). */
  turnTtlSeconds: number;
  /** 수신 벨이 울리는 시간(초). 클라이언트가 이 시간 뒤 자동 취소한다. */
  ringTimeoutSeconds: number;
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

/** 쉼표 구분 URL 목록을 검증해 배열로 만든다(잘못된 스킴은 기동 실패로 알린다). */
function parseUrlList(raw: string, schemes: string[], name: string): string[] {
  const urls = raw
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  for (const url of urls) {
    if (!schemes.some((scheme) => url.startsWith(`${scheme}:`))) {
      throw new Error(
        `${name} entries must start with ${schemes.map((scheme) => `${scheme}:`).join(" or ")} (got "${url}")`,
      );
    }
  }
  return urls;
}

/** 타일 템플릿에서 CSP 에 넣을 오리진을 뽑는다(플레이스홀더는 0 으로 치환). */
function tileOriginOf(template: string): string | null {
  if (template.length === 0) return null;
  try {
    const url = new URL(template.replace(/\{[a-z]\}/g, "0"));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

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
  if (value.CALL_TURN_URLS.trim().length > 0 && !value.CALL_TURN_SECRET) {
    throw new Error("CALL_TURN_SECRET is required when CALL_TURN_URLS is set");
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
    signupMode: value.SIGNUP_MODE,
    signupRequestEnabled: value.SIGNUP_REQUEST_ENABLED === "true",
    linkPreviewEnabled: value.LINK_PREVIEW_ENABLED === "true",
    mapTileUrl: value.MAP_TILE_URL.trim() === "" ? null : value.MAP_TILE_URL.trim(),
    mapTileOrigin: tileOriginOf(value.MAP_TILE_URL.trim()),
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
    calls: {
      enabled: value.CALL_ENABLED === "true",
      videoEnabled: value.CALL_VIDEO_ENABLED === "true",
      stunUrls: parseUrlList(value.CALL_STUN_URLS, ["stun"], "CALL_STUN_URLS"),
      turnUrls: parseUrlList(value.CALL_TURN_URLS, ["turn", "turns"], "CALL_TURN_URLS"),
      turnSecret: value.CALL_TURN_SECRET ?? null,
      turnTtlSeconds: value.CALL_TURN_TTL_SECONDS,
      ringTimeoutSeconds: value.CALL_RING_TIMEOUT_SECONDS,
    },
  };
}
