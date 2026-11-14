import { sql } from "drizzle-orm";
import {
  check,
  index,
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("devices_user_idx").on(table.userId)],
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
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.userId] }),
    index("conversation_participants_user_idx").on(table.userId),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_client_id_uq").on(
      table.conversationId,
      table.senderUserId,
      table.clientMessageId,
    ),
    index("messages_conversation_created_idx").on(table.conversationId, table.createdAt),
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
    // X25519 임시 공개키 32바이트
    ephemeralPublicKey: text("ephemeral_public_key").notNull(),
    // AES-256-GCM(KEK, wrapNonce, contentKey) base64
    wrappedKey: text("wrapped_key").notNull(),
    wrapNonce: text("wrap_nonce").notNull(),
    version: smallint("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.recipientDeviceId] }),
    index("message_keys_device_idx").on(table.recipientDeviceId),
    check("message_keys_version_chk", sql`${table.version} = 1`),
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

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type ParticipantRow = typeof conversationParticipants.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MessageKeyRow = typeof messageKeys.$inferSelect;
