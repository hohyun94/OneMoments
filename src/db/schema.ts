import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("users_username_uq").on(table.username)],
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
  },
  (table) => [
    uniqueIndex("sessions_token_hash_uq").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
    index("sessions_device_idx").on(table.deviceId),
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
    // X25519 공개키(base64, 32바이트)
    identityPublicKey: text("identity_public_key").notNull(),
    // Ed25519 공개키(base64, 32바이트)
    signingPublicKey: text("signing_public_key").notNull(),
    // X3DH signed prekey. 구버전 기기는 null → v2 정적 초기화 fallback.
    signedPreKeyId: text("signed_pre_key_id"),
    signedPreKeyPublicKey: text("signed_pre_key_public_key"),
    signedPreKeySignature: text("signed_pre_key_signature"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("devices_user_idx").on(table.userId)],
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("conversations_kind_chk", sql`${table.kind} in ('direct', 'group')`),
    check(
      "conversations_group_name_chk",
      sql`${table.kind} = 'direct' or (${table.name} is not null and char_length(${table.name}) between 1 and 64)`,
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
    // 그룹 Sender Keys(v3): 발신자 체인 ID/반복. pairwise 메시지는 null.
    senderKeyId: text("sender_key_id"),
    senderKeyIteration: integer("sender_key_iteration"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_client_id_uq").on(
      table.conversationId,
      table.senderUserId,
      table.clientMessageId,
    ),
    index("messages_conversation_created_idx").on(table.conversationId, table.createdAt),
    check(
      "messages_sender_key_chk",
      sql`(${table.senderKeyId} is null and ${table.senderKeyIteration} is null) or (${table.senderKeyId} is not null and ${table.senderKeyIteration} is not null)`,
    ),
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

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type ParticipantRow = typeof conversationParticipants.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MessageKeyRow = typeof messageKeys.$inferSelect;
