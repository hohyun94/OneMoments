import { sql } from "drizzle-orm";
import type { DevicePlatform } from "../types/protocol.js";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * 서버는 평문·대화 키·기기 개인키를 모른다.
 * messages.ciphertext 와 message_keys.wrapped_key 는 클라이언트가 만든 암호문이다.
 */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 소문자 정규화. 삭제(익명화) 후에도 행을 유지해 username 재사용을 막는다.
    username: text("username").notNull(),
    // 비밀번호 로그인. Google OAuth 전용 계정은 null 이며, 삭제(익명화) 시 "deleted-account" 로 덮는다.
    passwordHash: text("password_hash"),
    // Google OAuth 연결(제공자 + 불변 사용자 식별자 sub). 연결되지 않은 계정은 null.
    oauthProvider: text("oauth_provider"),
    oauthSubject: text("oauth_subject"),
    // 화면 테마(계정 동기화). mode: light/dark/system, accent: 프리셋 ID 또는 #rrggbb.
    themeMode: text("theme_mode").notNull().default("system"),
    themeAccent: text("theme_accent").notNull().default("violet"),
    // 공개 프로필 상태 메시지(최대 80자, 메시지 암호화 대상 아님).
    statusMessage: text("status_message"),
    // 마지막 접속 시각(WS 연결/해제 시 갱신). 공개 여부는 사용자가 옵트인한다.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastSeenVisible: boolean("last_seen_visible").notNull().default(false),
    // 공개 프로필 아바타. 상태 메시지와 같은 공개 메타데이터로, base64 텍스트(최대 256KB)로 저장한다.
    avatarMime: text("avatar_mime"),
    avatarData: text("avatar_data"),
    avatarUpdatedAt: timestamp("avatar_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("users_username_uq").on(table.username),
    // 같은 Google 계정(sub)이 두 사용자에게 연결되지 않게 한다(부분 유니크).
    uniqueIndex("users_oauth_uq")
      .on(table.oauthProvider, table.oauthSubject)
      .where(sql`${table.oauthSubject} is not null`),
    // 최소 하나의 자격 증명(비밀번호 또는 OAuth)을 항상 갖는다.
    check(
      "users_credential_chk",
      sql`${table.passwordHash} is not null or ${table.oauthSubject} is not null`,
    ),
    check(
      "users_oauth_provider_chk",
      sql`${table.oauthProvider} is null or ${table.oauthProvider} in ('google')`,
    ),
    check(
      "users_oauth_subject_chk",
      sql`(${table.oauthProvider} is null) = (${table.oauthSubject} is null)`,
    ),
    check("users_theme_mode_chk", sql`${table.themeMode} in ('light', 'dark', 'system')`),
    check(
      "users_theme_accent_chk",
      sql`${table.themeAccent} ~ '^(violet|blue|emerald|rose|amber|#[0-9a-f]{6})$'`,
    ),
    check(
      "users_status_message_chk",
      sql`${table.statusMessage} is null or char_length(${table.statusMessage}) <= 80`,
    ),
    check(
      "users_avatar_mime_chk",
      sql`${table.avatarMime} is null or ${table.avatarMime} in ('image/png', 'image/jpeg', 'image/webp')`,
    ),
    // mime 과 data 는 항상 함께 있거나 함께 없다.
    check(
      "users_avatar_pair_chk",
      sql`(${table.avatarMime} is null) = (${table.avatarData} is null)`,
    ),
  ],
);

export const userBlocks = pgTable(
  "user_blocks",
  {
    blockerUserId: uuid("blocker_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedUserId: uuid("blocked_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.blockerUserId, table.blockedUserId] }),
    index("user_blocks_blocked_idx").on(table.blockedUserId),
  ],
);

export const userFavorites = pgTable(
  "user_favorites",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    favoriteUserId: uuid("favorite_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.favoriteUserId] }),
    index("user_favorites_favorite_idx").on(table.favoriteUserId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 쿠키 원문이 아니라 SHA-256 해시만 저장한다.
    tokenHash: text("token_hash").notNull(),
    deviceId: uuid("device_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    // 이번 로그인에만 적용하는 무활동 로그아웃(초). null 이면 기기 기본값을 따른다.
    idleTimeoutSeconds: integer("idle_timeout_seconds"),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_uq").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
    index("sessions_device_idx").on(table.deviceId),
    check(
      "sessions_idle_timeout_chk",
      sql`${table.idleTimeoutSeconds} is null or (${table.idleTimeoutSeconds} between 60 and 1800)`,
    ),
  ],
);

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** 클라이언트 신고 플랫폼. UA 기반 추정이며 서버 권한 판단에는 쓰지 않는다. */
    platform: text("platform").$type<DevicePlatform>().notNull().default("unknown"),
    // X25519 공개키(base64, 32바이트)
    identityPublicKey: text("identity_public_key").notNull(),
    // Ed25519 공개키(base64, 32바이트)
    signingPublicKey: text("signing_public_key").notNull(),
    // X3DH signed prekey. 구버전 기기는 null → v2 정적 초기화 fallback.
    signedPreKeyId: text("signed_pre_key_id"),
    signedPreKeyPublicKey: text("signed_pre_key_public_key"),
    signedPreKeySignature: text("signed_pre_key_signature"),
    // 기기의 기본 무활동 로그아웃(초). 세션 오버라이드가 없을 때 적용된다.
    idleTimeoutSeconds: integer("idle_timeout_seconds").notNull().default(300),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("devices_user_idx").on(table.userId),
    check(
      "devices_platform_chk",
      sql`${table.platform} in ('ios', 'android', 'mobile', 'desktop', 'unknown')`,
    ),
    check(
      "devices_idle_timeout_chk",
      sql`${table.idleTimeoutSeconds} between 60 and 1800`,
    ),
  ],
);

export const deviceOneTimePreKeys = pgTable(
  "device_one_time_pre_keys",
  {
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    keyId: uuid("key_id").notNull(),
    publicKey: text("public_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // 메시지 저장 트랜잭션에서 한 번만 소비한다.
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.keyId] }),
    index("device_one_time_pre_keys_device_idx").on(table.deviceId, table.usedAt),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull().default("direct"),
    // 그룹 이름(direct 는 null)
    name: text("name"),
    // 참여자 모두가 읽은 뒤 자동 삭제까지의 시간(초). null 이면 끔. 1시간~30일.
    autoDeleteAfterReadSeconds: integer("auto_delete_after_read_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("conversations_kind_chk", sql`${table.kind} in ('direct', 'group')`),
    check(
      "conversations_group_name_chk",
      sql`${table.kind} = 'direct' or (${table.name} is not null and char_length(${table.name}) between 1 and 64)`,
    ),
    check(
      "conversations_auto_delete_chk",
      sql`${table.autoDeleteAfterReadSeconds} is null or (${table.autoDeleteAfterReadSeconds} between 3600 and 2592000)`,
    ),
  ],
);

export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    // 대화 삭제는 내 화면에서만 숨긴다(상대 이력 유지).
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    // 이 대화의 푸시 알림을 끈 시각(사용자별).
    mutedAt: timestamp("muted_at", { withTimezone: true }),
    // 그룹 소유자/일반 참여자. 기존 그룹은 마이그레이션에서 가장 먼저 참여한 사용자를 owner로 승격한다.
    role: text("role").notNull().default("member"),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.userId] }),
    index("conversation_participants_user_idx").on(table.userId),
    check("conversation_participants_role_chk", sql`${table.role} in ('owner', 'member')`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    // 계정 삭제는 익명화(soft delete)라 메시지의 발신자 참조를 유지한다.
    senderUserId: uuid("sender_user_id")
      .notNull()
      .references(() => users.id),
    senderDeviceId: uuid("sender_device_id")
      .notNull()
      .references(() => devices.id),
    // 발신 기기 서명 공개키 스냅샷. 기기가 폐기돼도 과거 메시지 서명을 검증할 수 있다.
    senderSigningPublicKey: text("sender_signing_public_key").notNull(),
    // AES-256-GCM(ciphertext||tag) base64
    ciphertext: text("ciphertext").notNull(),
    // 12바이트 GCM nonce base64
    nonce: text("nonce").notNull(),
    // Ed25519 서명 base64 (conversationId, clientMessageId, sha256(ciphertext))
    signature: text("signature").notNull(),
    clientMessageId: text("client_message_id").notNull(),
    // text(일반/답장), reaction(이모지), edit(수정 이벤트). 내용은 모두 암호문 안에 있다.
    kind: text("kind").notNull().default("text"),
    // 반응/수정/답장의 대상 메시지. 대상이 삭제되면 참조만 해제된다(반응·수정은 삭제 시 함께 정리).
    targetMessageId: uuid("target_message_id").references(
      (): AnyPgColumn => messages.id,
      { onDelete: "set null" },
    ),
    // 그룹 Sender Keys(v3): 발신자 체인 ID/반복. pairwise 메시지는 null.
    senderKeyId: text("sender_key_id"),
    senderKeyIteration: integer("sender_key_iteration"),
    /** 대화 상단에 고정된 시각. null 이면 고정 아님(내용은 여전히 암호문). */
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    /** 한 번 보기: 수신자가 열람하면 서버에서 메시지·봉투·첨부를 삭제한다. */
    viewOnce: boolean("view_once").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_client_id_uq").on(
      table.conversationId,
      table.senderUserId,
      table.clientMessageId,
    ),
    index("messages_conversation_created_idx").on(table.conversationId, table.createdAt),
    index("messages_target_idx").on(table.targetMessageId),
    check(
      "messages_kind_chk",
      sql`${table.kind} in ('text', 'reaction', 'edit')`,
    ),
    check(
      "messages_sender_key_chk",
      sql`(${table.senderKeyId} is null and ${table.senderKeyIteration} is null) or (${table.senderKeyId} is not null and ${table.senderKeyIteration} is not null)`,
    ),
  ],
);

export const messageDeletions = pgTable(
  "message_deletions",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId] }),
    index("message_deletions_user_idx").on(table.userId),
  ],
);

export const messageKeys = pgTable(
  "message_keys",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    recipientDeviceId: uuid("recipient_device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    // v1: X25519 임시 공개키(정적 기기 키 봉투). v2: null
    ephemeralPublicKey: text("ephemeral_public_key"),
    // v2: Double Ratchet 헤더. v1: null
    ratchetPublicKey: text("ratchet_public_key"),
    previousChainLength: integer("previous_chain_length"),
    messageNumber: integer("message_number"),
    // X3DH 초기 봉투: 발신자 IK와 사용한 signed prekey ID(둘 다 없으면 legacy v2)
    senderIdentityPublicKey: text("sender_identity_public_key"),
    signedPreKeyId: text("signed_pre_key_id"),
    // X3DH 원타임 프리키(서버가 메시지 저장 시 1회 소비)
    oneTimePreKeyId: text("one_time_pre_key_id"),
    // Sender Keys 최초 배포: sender key 체인 상태를 암호화한 블롭(수신 기기별 복호화)
    distributionCiphertext: text("distribution_ciphertext"),
    distributionNonce: text("distribution_nonce"),
    // AES-256-GCM(KEK 또는 ratchet message key, wrapNonce, contentKey) base64
    wrappedKey: text("wrapped_key").notNull(),
    wrapNonce: text("wrap_nonce").notNull(),
    version: smallint("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.recipientDeviceId] }),
    index("message_keys_device_idx").on(table.recipientDeviceId),
    check("message_keys_version_chk", sql`${table.version} in (1, 2)`),
    check(
      "message_keys_envelope_chk",
      sql`(${table.version} = 1 and ${table.ephemeralPublicKey} is not null and ${table.ratchetPublicKey} is null) or (${table.version} = 2 and ${table.ephemeralPublicKey} is null and ${table.ratchetPublicKey} is not null and ${table.previousChainLength} is not null and ${table.messageNumber} is not null)`,
    ),
    check(
      "message_keys_distribution_chk",
      sql`(${table.distributionCiphertext} is null and ${table.distributionNonce} is null) or (${table.distributionCiphertext} is not null and ${table.distributionNonce} is not null)`,
    ),
    check(
      "message_keys_x3dh_chk",
      sql`(${table.senderIdentityPublicKey} is null and ${table.signedPreKeyId} is null) or (${table.senderIdentityPublicKey} is not null and ${table.signedPreKeyId} is not null)`,
    ),
  ],
);

/**
 * 메시지별 읽은 시각. 참여자 전원이 읽은 뒤 자동 삭제를 계산하는 데 쓴다.
 * 대화의 마지막 읽음 커서(conversation_reads)와 별도로 유지한다.
 */
export const messageReads = pgTable(
  "message_reads",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId] }),
    index("message_reads_user_idx").on(table.userId, table.readAt),
  ],
);

export const keyBackups = pgTable(
  "key_backups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    // 클라이언트가 복구 암호로 암호화한 불투명 블롭(JSON). 서버는 복호화하지 않는다.
    blob: text("blob").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("key_backups_device_uq").on(table.deviceId),
    index("key_backups_user_idx").on(table.userId),
  ],
);

export const recoveryChallenges = pgTable(
  "recovery_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    // 기기 서명키로 서명해야 하는 일회용 nonce
    nonce: text("nonce").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("recovery_challenges_device_idx").on(table.deviceId)],
);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    uploaderUserId: uuid("uploader_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 암호문 크기만 저장한다. 파일 이름·MIME·키는 메시지 암호문 안에만 있다.
    size: integer("size").notNull(),
    // 업로드 시 예약한 메시지 clientMessageId. 메시지 저장 시 messageId로 연결된다.
    messageClientId: text("message_client_id"),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("attachments_conversation_idx").on(table.conversationId),
    index("attachments_message_client_idx").on(table.messageClientId),
  ],
);

/** 24시간 스토리. id 는 클라이언트가 생성해 서명/AAD 에 사용한다. */
export const moments = pgTable(
  "moments",
  {
    id: uuid("id").primaryKey(),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authorDeviceId: uuid("author_device_id")
      .notNull()
      .references(() => devices.id),
    // 발신 기기 서명 공개키 스냅샷(기기 폐기 후에도 서명 검증 가능).
    authorSigningPublicKey: text("author_signing_public_key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    signature: text("signature").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("moments_author_idx").on(table.authorUserId),
    index("moments_expires_idx").on(table.expiresAt),
  ],
);

export const momentAudience = pgTable(
  "moment_audience",
  {
    momentId: uuid("moment_id")
      .notNull()
      .references(() => moments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.momentId, table.userId] }),
    index("moment_audience_user_idx").on(table.userId),
  ],
);

export const momentKeys = pgTable(
  "moment_keys",
  {
    momentId: uuid("moment_id")
      .notNull()
      .references(() => moments.id, { onDelete: "cascade" }),
    recipientDeviceId: uuid("recipient_device_id")
      .notNull()
      .references(() => devices.id),
    ephemeralPublicKey: text("ephemeral_public_key"),
    ratchetPublicKey: text("ratchet_public_key"),
    previousChainLength: integer("previous_chain_length"),
    messageNumber: integer("message_number"),
    senderIdentityPublicKey: text("sender_identity_public_key"),
    signedPreKeyId: text("signed_pre_key_id"),
    oneTimePreKeyId: text("one_time_pre_key_id"),
    wrappedKey: text("wrapped_key").notNull(),
    wrapNonce: text("wrap_nonce").notNull(),
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.momentId, table.recipientDeviceId] }),
    index("moment_keys_device_idx").on(table.recipientDeviceId),
  ],
);

export const momentViews = pgTable(
  "moment_views",
  {
    momentId: uuid("moment_id")
      .notNull()
      .references(() => moments.id, { onDelete: "cascade" }),
    viewerUserId: uuid("viewer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.momentId, table.viewerUserId] }),
    index("moment_views_viewer_idx").on(table.viewerUserId),
  ],
);

export const momentAttachments = pgTable(
  "moment_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    uploaderUserId: uuid("uploader_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 업로드 시 예약한 moment id. 스토리 생성 시 momentId로 연결된다.
    clientMomentId: uuid("client_moment_id"),
    momentId: uuid("moment_id").references(() => moments.id, {
      onDelete: "cascade",
    }),
    // 암호문 크기만 저장한다.
    size: integer("size").notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("moment_attachments_uploader_idx").on(table.uploaderUserId),
    index("moment_attachments_client_idx").on(table.clientMomentId),
  ],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    // Push 서비스 엔드포인트(브라우저가 발급). 서버는 알림 전송에만 사용한다.
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    failureCount: integer("failure_count").notNull().default(0),
  },
  (table) => [
    uniqueIndex("push_subscriptions_endpoint_uq").on(table.endpoint),
    index("push_subscriptions_user_idx").on(table.userId),
  ],
);

export const loginProfiles = pgTable(
  "login_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 사용자가 입력하는 로그인 ID(실제 계정의 username)
    alias: text("alias").notNull(),
    // decoy 프로필의 users 행
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 관리자가 설정한 decoy 비밀번호 해시
    passwordHash: text("password_hash").notNull(),
    kind: text("kind").notNull().default("decoy"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("login_profiles_alias_uq").on(table.alias),
    index("login_profiles_user_idx").on(table.userId),
    check("login_profiles_kind_chk", sql`${table.kind} in ('decoy')`),
  ],
);

/**
 * OAuth 진행 상태. CSRF state 와 PKCE code_verifier 를 담는 단명·1회용 행이다.
 * state 원문은 브라우저 쿠키와 콜백 URL 에만 존재하고 DB 에는 SHA-256 해시만 저장한다.
 */
export const oauthStates = pgTable(
  "oauth_states",
  {
    stateHash: text("state_hash").primaryKey(),
    provider: text("provider").notNull().default("google"),
    /** signup | login | link */
    intent: text("intent").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    /** link 의도일 때 연결 대상(세션 사용자) */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("oauth_states_expires_idx").on(table.expiresAt),
    check("oauth_states_provider_chk", sql`${table.provider} in ('google')`),
    check("oauth_states_intent_chk", sql`${table.intent} in ('signup', 'login', 'link')`),
    check("oauth_states_link_chk", sql`${table.intent} <> 'link' or ${table.userId} is not null`),
  ],
);

/**
 * OAuth 콜백 → SPA 완료 단계로 넘기는 1회용 티켓.
 * 기기 키는 브라우저에서만 생성되므로, 서버는 티켓만 주고 완료 요청에서 기기 공개키를 받는다.
 * 이메일은 표시용으로만 잠시 보관하고 소비 시 행을 삭제한다.
 */
export const oauthTickets = pgTable(
  "oauth_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull().default("google"),
    subject: text("subject").notNull(),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    /** signup | login | link */
    intent: text("intent").notNull(),
    /** login·link 의도일 때 대상 사용자 */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("oauth_tickets_expires_idx").on(table.expiresAt),
    check("oauth_tickets_provider_chk", sql`${table.provider} in ('google')`),
    check("oauth_tickets_intent_chk", sql`${table.intent} in ('signup', 'login', 'link')`),
    check(
      "oauth_tickets_link_chk",
      sql`${table.intent} = 'signup' or ${table.userId} is not null`,
    ),
  ],
);

export const callLogs = pgTable(
  "call_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 통화 세션 ID(클라이언트가 만든 UUID). 재전송되어도 한 건만 남긴다. */
    callId: uuid("call_id").notNull().unique(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    callerUserId: uuid("caller_user_id")
      .notNull()
      .references(() => users.id),
    calleeUserId: uuid("callee_user_id")
      .notNull()
      .references(() => users.id),
    /** ringing | completed | missed | declined | cancelled | failed */
    status: text("status").notNull(),
    /** audio | video */
    media: text("media").notNull().default("audio"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** 수신자가 부재중 기록을 확인한 시각(배지 해제용). */
    calleeSeenAt: timestamp("callee_seen_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "call_logs_status_chk",
      sql`${table.status} in ('ringing', 'completed', 'missed', 'declined', 'cancelled', 'failed')`,
    ),
    check("call_logs_media_chk", sql`${table.media} in ('audio', 'video')`),
    index("call_logs_conversation_idx").on(table.conversationId, table.startedAt),
  ],
);

export const conversationInvites = pgTable(
  "conversation_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxUses: integer("max_uses").notNull().default(10),
    uses: integer("uses").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("conversation_invites_token_uq").on(table.tokenHash),
    index("conversation_invites_conversation_idx").on(table.conversationId),
  ],
);

export const conversationReads = pgTable(
  "conversation_reads",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadMessageId: uuid("last_read_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.userId] }),
    index("conversation_reads_user_idx").on(table.userId),
  ],
);

/**
 * 관리자 조치 감사 로그. 평문·키·비밀번호·세션 토큰은 절대 넣지 않는다.
 * 관리자/대상 계정이 삭제되어도 기록을 읽을 수 있도록 username 스냅샷을 함께 둔다.
 */
export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminUserId: uuid("admin_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    adminUsername: text("admin_username").notNull(),
    action: text("action").notNull(),
    targetUserId: uuid("target_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    targetUsername: text("target_username"),
    // 작업 메타데이터만(예: 종료한 세션 수, decoy alias). 메시지 내용은 금지.
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("admin_audit_logs_created_idx").on(table.createdAt)],
);

/**
 * 인증 이벤트 로그(로그인·로그아웃·복구·기기 폐기). 관리자 전용 조회.
 * 세션 행은 삭제되지만 이 기록은 **append-only**로 남긴다.
 * IP·user-agent 는 관리자 감사 목적이며 stdout 로그에는 남기지 않는다.
 */
export const authEvents = pgTable(
  "auth_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 대상 기기. 기기 식별이 없는 조치(관리자 일괄 세션 종료)는 null */
    deviceId: uuid("device_id"),
    event: text("event").notNull(),
    /** 요청 IP. 신뢰 프록시 설정(TRUST_PROXY)에 따라 X-Forwarded-For 를 쓴다. */
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("auth_events_user_created_idx").on(table.userId, table.createdAt)],
);

/**
 * 가입 초대 코드(관리자 발급).
 *
 * `SIGNUP_MODE=invite` 일 때만 사용되며, 코드는 대문자/숫자로 정규화해 저장한다.
 * 사용 횟수·만료·폐기로 통제하고, 가입 트랜잭션 안에서 원자적으로 소모한다.
 */
export const signupInvites = pgTable(
  "signup_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    /** 발급한 관리자(계정 삭제 시 null). */
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** 사용 가능 횟수(1~100). */
    maxUses: integer("max_uses").notNull().default(1),
    usedCount: integer("used_count").notNull().default(0),
    /** 만료 시각. null 이면 무기한. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("signup_invites_code_uq").on(table.code),
    check("signup_invites_max_uses_chk", sql`${table.maxUses} >= 1 and ${table.maxUses} <= 100`),
    check("signup_invites_used_count_chk", sql`${table.usedCount} >= 0`),
  ],
);

/**
 * 가입 신청(관리자 승인형 가입).
 *
 * 초대 코드 경로와 **나란히** 쓰인다(`SIGNUP_REQUEST_ENABLED=true`). 신청 단계에서는
 * 비밀번호·기기 키를 받지 않는다(E2E 불변식 — 승인 전 비밀 정보 미보관). 관리자가 승인하면
 * **1회용 초대 코드**를 발급하고, 신청자는 그 코드로 `/api/auth/register` 를 완료한다.
 *
 * 상태 조회는 신청 시 1회 발급한 토큰의 **해시**로만 가능하다(원문은 저장하지 않는다).
 */
export const signupRequests = pgTable(
  "signup_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 신청한 아이디(가입 시점에 다시 검증한다). */
    username: text("username").notNull(),
    /** 신청자가 남긴 가입 사유(평문 메타데이터, 5~500자). 관리자 승인 판단 근거. */
    note: text("note"),
    /** pending | approved | rejected */
    status: text("status").notNull().default("pending"),
    /** 상태 조회 토큰의 SHA-256(hex). */
    tokenHash: text("token_hash").notNull(),
    /** 승인 시 발급한 1회용 초대 코드. */
    inviteId: uuid("invite_id").references(() => signupInvites.id, { onDelete: "set null" }),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** 거절 사유(관리자 메모). 승인 시에는 비운다. */
    reviewNote: text("review_note"),
    /** 신청자가 승인 후 실제로 가입을 마친 시각(1회용). */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("signup_requests_token_uq").on(table.tokenHash),
    index("signup_requests_status_created_idx").on(table.status, table.createdAt),
    index("signup_requests_username_idx").on(table.username),
    check(
      "signup_requests_status_chk",
      sql`${table.status} in ('pending', 'approved', 'rejected')`,
    ),
  ],
);

/**
 * 일기장 — 24시간 만료가 없는 공유 공간. 지정한 대상에게만 공개한다.
 *
 * E2E 규칙: 글 본문·제목은 **암호문만** 저장하고, 서버는 메타데이터(작성자·대상·날짜·크기)만 안다.
 * 대상이 바뀌면 `keyEpoch` 를 올려 **새 키로만 새 글을 쓰게** 한다(정책 B). 과거 글은 그 시점
 * 봉투를 가진 사람만 열 수 있으므로, 새로 추가된 대상자는 과거 글을 볼 수 없다.
 * (일기장 이름은 프로필 상태처럼 공개 메타데이터로 취급한다 — 최대 40자 평문.)
 */
export const diaries = pgTable(
  "diaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 일기장 이름(선택, 평문 메타데이터). */
    label: text("label"),
    /** 현재 키 세대. 대상이 바뀔 때마다 +1 한다. */
    keyEpoch: integer("key_epoch").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("diaries_owner_idx").on(table.ownerUserId),
    check("diaries_key_epoch_chk", sql`${table.keyEpoch} >= 1`),
  ],
);

/** 일기장 공유 대상. `joinedEpoch` 이후 세대의 글에만 봉투가 배포된다. */
export const diaryAudience = pgTable(
  "diary_audience",
  {
    diaryId: uuid("diary_id")
      .notNull()
      .references(() => diaries.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 합류 시점의 키 세대(이 세대 이전 글은 열 수 없다). */
    joinedEpoch: integer("joined_epoch").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.diaryId, table.userId] }),
    index("diary_audience_user_idx").on(table.userId),
  ],
);

/** 일기 글 1건. 본문·제목은 ciphertext 안에만 있다. */
export const diaryEntries = pgTable(
  "diary_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    diaryId: uuid("diary_id")
      .notNull()
      .references(() => diaries.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authorDeviceId: uuid("author_device_id")
      .notNull()
      .references(() => devices.id),
    /** 기기 폐기 후에도 서명을 검증할 수 있도록 스냅샷을 남긴다. */
    authorSigningPublicKey: text("author_signing_public_key").notNull(),
    /** 이 글이 암호화된 키 세대. 대상 변경 이후 글은 더 큰 값을 가진다. */
    keyEpoch: integer("key_epoch").notNull(),
    /** 클라이언트가 만든 멱등 키(재전송 중복 방지). */
    clientEntryId: uuid("client_entry_id").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    signature: text("signature").notNull(),
    /** 작성 시점 대상자 수(감사·표시용 메타데이터). */
    recipientCount: integer("recipient_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("diary_entries_client_uq").on(table.authorUserId, table.clientEntryId),
    index("diary_entries_diary_created_idx").on(table.diaryId, table.createdAt),
  ],
);

/** 글 1건의 수신 기기별 봉투(메시지와 동일한 v1/v2 형식). */
export const diaryEntryKeys = pgTable(
  "diary_entry_keys",
  {
    entryId: uuid("entry_id")
      .notNull()
      .references(() => diaryEntries.id, { onDelete: "cascade" }),
    recipientDeviceId: uuid("recipient_device_id")
      .notNull()
      .references(() => devices.id),
    ephemeralPublicKey: text("ephemeral_public_key"),
    ratchetPublicKey: text("ratchet_public_key"),
    previousChainLength: integer("previous_chain_length"),
    messageNumber: integer("message_number"),
    senderIdentityPublicKey: text("sender_identity_public_key"),
    signedPreKeyId: text("signed_pre_key_id"),
    oneTimePreKeyId: text("one_time_pre_key_id"),
    wrappedKey: text("wrapped_key"),
    wrapNonce: text("wrap_nonce"),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.recipientDeviceId] }),
    index("diary_entry_keys_device_idx").on(table.recipientDeviceId),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type ParticipantRow = typeof conversationParticipants.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MessageKeyRow = typeof messageKeys.$inferSelect;
export type MessageReadRow = typeof messageReads.$inferSelect;
export type MomentRow = typeof moments.$inferSelect;
export type MomentKeyRow = typeof momentKeys.$inferSelect;
export type MomentAudienceRow = typeof momentAudience.$inferSelect;
export type MomentViewRow = typeof momentViews.$inferSelect;
export type MomentAttachmentRow = typeof momentAttachments.$inferSelect;
export type AdminAuditLogRow = typeof adminAuditLogs.$inferSelect;
export type AuthEventRow = typeof authEvents.$inferSelect;
export type SignupInviteRow = typeof signupInvites.$inferSelect;
export type SignupRequestRow = typeof signupRequests.$inferSelect;
/**
 * 일기 첨부(사진) — **암호문 블롭만** 저장한다.
 *
 * 업로드 시점에는 `clientEntryId` 로 예약만 하고, 글 저장 트랜잭션에서 `entryId` 로 연결한다.
 * 서버는 파일 이름·MIME·키를 저장하지 않고 **암호문 크기만** 기록한다(불변식 11).
 */
export const diaryAttachments = pgTable(
  "diary_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    uploaderUserId: uuid("uploader_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 글 작성 시 클라이언트가 만든 멱등 키. 글 저장 시점에 entryId 로 연결된다. */
    clientEntryId: uuid("client_entry_id"),
    entryId: uuid("entry_id").references(() => diaryEntries.id, { onDelete: "cascade" }),
    /** 암호문 크기만 저장한다(평문 크기·파일명 없음). */
    size: integer("size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("diary_attachments_entry_idx").on(table.entryId),
    index("diary_attachments_client_idx").on(table.uploaderUserId, table.clientEntryId),
  ],
);

/**
 * 글 수정 이력.
 *
 * 수정 시 **그 시점 봉투(keys)까지** 함께 스냅샷한다. 봉투를 보관하지 않으면
 * 나중에 그 버전을 복호화할 수 없기 때문이다(수정 시 새 키·새 봉투로 교체됨).
 * 삭제 시 글과 함께 cascade 로 사라진다.
 */
export const diaryEntryVersions = pgTable(
  "diary_entry_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => diaryEntries.id, { onDelete: "cascade" }),
    /** 1부터 증가하는 버전 번호. */
    versionNo: integer("version_no").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    signature: text("signature").notNull(),
    keyEpoch: integer("key_epoch").notNull(),
    /** 그 시점 수신 기기별 봉투 스냅샷(복호화에 필요). */
    keys: jsonb("keys").$type<unknown[]>().notNull(),
    editedByUserId: uuid("edited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("diary_entry_versions_uq").on(table.entryId, table.versionNo),
    index("diary_entry_versions_entry_idx").on(table.entryId),
  ],
);

export type DiaryRow = typeof diaries.$inferSelect;
export type DiaryEntryVersionRow = typeof diaryEntryVersions.$inferSelect;
export type DiaryAttachmentRow = typeof diaryAttachments.$inferSelect;
export type DiaryAudienceRow = typeof diaryAudience.$inferSelect;
export type DiaryEntryRow = typeof diaryEntries.$inferSelect;
export type DiaryEntryKeyRow = typeof diaryEntryKeys.$inferSelect;
export type OAuthStateRow = typeof oauthStates.$inferSelect;
export type OAuthTicketRow = typeof oauthTickets.$inferSelect;
export type CallLogRow = typeof callLogs.$inferSelect;