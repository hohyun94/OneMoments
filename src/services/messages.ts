import { and, desc, eq, gte, isNotNull, isNull, lt, notExists, or, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  attachments,
  conversationParticipants,
  conversations,
  deviceOneTimePreKeys,
  messageDeletions,
  messageKeys,
  messages,
  type MessageKeyRow,
  type MessageRow,
} from "../db/schema.js";
import { AppError } from "../http/errors.js";
import { toMessageView } from "../http/serializers.js";
import type { MessageView } from "../types/protocol.js";
import type { NormalizedMessagePayload } from "../crypto/envelope.js";

export interface CreateMessageInput {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  senderSigningPublicKey: string;
  payload: NormalizedMessagePayload;
  kind: "text" | "reaction" | "edit";
  /** 한 번 보기 메시지(수신자가 열람하면 삭제). text 메시지에만 적용된다. */
  viewOnce?: boolean;
  targetMessageId?: string | undefined;
}

export interface CreateMessageResult {
  message: MessageRow;
  keys: MessageKeyRow[];
  created: boolean;
}

/**
 * 암호문 1건 + 기기별 키 봉투 N건을 한 트랜잭션으로 저장한다.
 * `(conversationId, senderUserId, clientMessageId)` 가 같으면 기존 메시지를 돌려준다(멱등).
 */
export async function createMessage(
  db: Database,
  input: CreateMessageInput,
): Promise<CreateMessageResult> {
  const { payload } = input;

  return db.transaction(async (tx) => {
    if (input.kind !== "text" && !input.targetMessageId) {
      throw AppError.badRequest(
        "TARGET_REQUIRED",
        "Reaction and edit messages require targetMessageId",
      );
    }

    if (input.targetMessageId) {
      const [target] = await tx
        .select({
          id: messages.id,
          kind: messages.kind,
          senderUserId: messages.senderUserId,
        })
        .from(messages)
        .where(
          and(
            eq(messages.id, input.targetMessageId),
            eq(messages.conversationId, input.conversationId),
          ),
        )
        .limit(1);
      if (!target) {
        throw AppError.badRequest("INVALID_TARGET", "Target message not found");
      }
      if (target.kind !== "text") {
        throw AppError.badRequest(
          "INVALID_TARGET",
          "Only text messages can be replied to, reacted to, or edited",
        );
      }
      if (input.kind === "edit" && target.senderUserId !== input.senderUserId) {
        throw AppError.forbidden("Only the sender can edit this message");
      }
      if (input.kind === "edit") {
        const [attachment] = await tx
          .select({ id: attachments.id })
          .from(attachments)
          .where(eq(attachments.messageId, target.id))
          .limit(1);
        if (attachment) {
          throw AppError.badRequest(
            "INVALID_TARGET",
            "Messages with attachments cannot be edited",
          );
        }
      }
    }

    const [inserted] = await tx
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        senderUserId: input.senderUserId,
        senderDeviceId: input.senderDeviceId,
        senderSigningPublicKey: input.senderSigningPublicKey,
        ciphertext: payload.ciphertext,
        nonce: payload.nonce,
        signature: payload.signature,
        clientMessageId: payload.clientMessageId,
        kind: input.kind,
        targetMessageId: input.targetMessageId ?? null,
        viewOnce: input.kind === "text" ? (input.viewOnce ?? false) : false,
        senderKeyId: payload.senderKeyId,
        senderKeyIteration: payload.senderKeyIteration,
      })
      .onConflictDoNothing({
        target: [messages.conversationId, messages.senderUserId, messages.clientMessageId],
      })
      .returning();

    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, input.conversationId),
            eq(messages.senderUserId, input.senderUserId),
            eq(messages.clientMessageId, payload.clientMessageId),
          ),
        )
        .limit(1);
      if (!existing) {
        throw AppError.conflict("MESSAGE_CONFLICT", "Message could not be stored");
      }
      const existingKeys = await tx
        .select()
        .from(messageKeys)
        .where(eq(messageKeys.messageId, existing.id));
      await tx
        .update(attachments)
        .set({ messageId: existing.id })
        .where(
          and(
            eq(attachments.conversationId, input.conversationId),
            eq(attachments.uploaderUserId, input.senderUserId),
            eq(attachments.messageClientId, payload.clientMessageId),
            isNull(attachments.messageId),
          ),
        );
      return { message: existing, keys: existingKeys, created: false };
    }

    for (const key of payload.keys) {
      if (key.version !== 2 || !key.oneTimePreKeyId) continue;
      const [preKey] = await tx
        .select({
          keyId: deviceOneTimePreKeys.keyId,
          usedAt: deviceOneTimePreKeys.usedAt,
        })
        .from(deviceOneTimePreKeys)
        .where(
          and(
            eq(deviceOneTimePreKeys.deviceId, key.deviceId),
            eq(deviceOneTimePreKeys.keyId, key.oneTimePreKeyId),
          ),
        )
        .limit(1);
      if (!preKey) {
        throw AppError.conflict(
          "PREKEY_CONSUMED",
          "Unknown one-time prekey; refresh the device bundle",
        );
      }
      if (!preKey.usedAt) {
        await tx
          .update(deviceOneTimePreKeys)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(deviceOneTimePreKeys.deviceId, key.deviceId),
              eq(deviceOneTimePreKeys.keyId, key.oneTimePreKeyId),
              isNull(deviceOneTimePreKeys.usedAt),
            ),
          );
      }
    }

    const keys =
      payload.keys.length === 0
        ? []
        : await tx
            .insert(messageKeys)
            .values(
              payload.keys.map((key) => ({
                messageId: inserted.id,
                recipientDeviceId: key.deviceId,
                ephemeralPublicKey: key.version === 1 ? key.ephemeralPublicKey : null,
                ratchetPublicKey: key.version === 2 ? key.ratchetPublicKey : null,
                previousChainLength:
                  key.version === 2 ? key.previousChainLength : null,
                messageNumber: key.version === 2 ? key.messageNumber : null,
                senderIdentityPublicKey:
                  key.version === 2 ? (key.senderIdentityPublicKey ?? null) : null,
                signedPreKeyId:
                  key.version === 2 ? (key.signedPreKeyId ?? null) : null,
                oneTimePreKeyId:
                  key.version === 2 ? (key.oneTimePreKeyId ?? null) : null,
                distributionCiphertext:
                  key.distribution !== undefined ? key.distribution.ciphertext : null,
                distributionNonce: key.distribution !== undefined ? key.distribution.nonce : null,
                wrappedKey: key.wrappedKey,
                wrapNonce: key.wrapNonce,
                version: key.version,
              })),
            )
            .returning();

    await tx
      .update(attachments)
      .set({ messageId: inserted.id })
      .where(
        and(
          eq(attachments.conversationId, input.conversationId),
          eq(attachments.uploaderUserId, input.senderUserId),
          eq(attachments.messageClientId, payload.clientMessageId),
          isNull(attachments.messageId),
        ),
      );

    return { message: inserted, keys, created: true };
  });
}

export interface MessagePage {
  messages: MessageView[];
  nextCursor: string | null;
}

export interface ListMessagesInput {
  conversationId: string;
  viewerDeviceId: string;
  viewerUserId: string;
  before?: string | undefined;
  limit: number;
  /** true 면 고정된 메시지만 최신순으로 조회한다(커서 무시). */
  pinnedOnly?: boolean;
}

export async function listMessages(
  db: Database,
  input: ListMessagesInput,
): Promise<MessagePage> {
  let cursor: { createdAt: Date; id: string } | null = null;
  if (input.before) {
    const [row] = await db
      .select({ createdAt: messages.createdAt, id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.before),
          eq(messages.conversationId, input.conversationId),
        ),
      )
      .limit(1);
    if (!row) throw AppError.badRequest("INVALID_CURSOR", "Unknown message cursor");
    cursor = row;
  }

  const [participant] = await db
    .select({ joinedAt: conversationParticipants.joinedAt })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, input.conversationId),
        eq(conversationParticipants.userId, input.viewerUserId),
      ),
    )
    .limit(1);
  const joinedAt = participant?.joinedAt ?? new Date(0);

  const rows = await db
    .select({ message: messages, key: messageKeys })
    .from(messages)
    .leftJoin(
      messageKeys,
      and(
        eq(messageKeys.messageId, messages.id),
        eq(messageKeys.recipientDeviceId, input.viewerDeviceId),
      ),
    )
    .where(
      and(
        eq(messages.conversationId, input.conversationId),
        or(
          isNotNull(messageKeys.messageId),
          and(isNotNull(messages.senderKeyId), gte(messages.createdAt, joinedAt)),
        ),
        // 나에게만 삭제한 메시지는 이력에서 제외한다(다른 참여자에게는 유지).
        notExists(
          db
            .select({ one: sql`1` })
            .from(messageDeletions)
            .where(
              and(
                eq(messageDeletions.messageId, messages.id),
                eq(messageDeletions.userId, input.viewerUserId),
              ),
            ),
        ),
        input.pinnedOnly ? isNotNull(messages.pinnedAt) : undefined,
        input.pinnedOnly
          ? undefined
          : cursor
            ? or(
                lt(messages.createdAt, cursor.createdAt),
                and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id)),
              )
            : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const hasMore = rows.length > input.limit;
  return {
    messages: page.map((row) => toMessageView(row.message, row.key)),
    nextCursor: hasMore ? (page.at(-1)?.message.id ?? null) : null,
  };
}

export async function listMessageKeys(
  db: Database,
  messageId: string,
): Promise<MessageKeyRow[]> {
  return db.select().from(messageKeys).where(eq(messageKeys.messageId, messageId));
}

/**
 * 메시지 고정 토글. 서버에는 `pinned_at` 메타데이터만 저장하고 본문은 건드리지 않는다.
 * 권한: 1:1 은 참여자 누구나, 그룹은 소유자(owner) 또는 원 발신자만.
 */
export async function setMessagePinned(
  db: Database,
  input: {
    conversationId: string;
    messageId: string;
    userId: string;
    pinned: boolean;
  },
): Promise<MessageRow> {
  const [row] = await db
    .select({
      message: messages,
      conversationKind: conversations.kind,
      role: conversationParticipants.role,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(
      conversationParticipants,
      and(
        eq(conversationParticipants.conversationId, messages.conversationId),
        eq(conversationParticipants.userId, input.userId),
      ),
    )
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(messages.conversationId, input.conversationId),
      ),
    )
    .limit(1);

  if (!row) throw AppError.notFound("MESSAGE_NOT_FOUND", "Message not found");
  if (row.message.kind !== "text") {
    throw AppError.badRequest("INVALID_MESSAGE_KIND", "Only text messages can be pinned");
  }
  const isGroupOwner = row.role === "owner";
  const isSender = row.message.senderUserId === input.userId;
  if (row.conversationKind === "group" && !isGroupOwner && !isSender) {
    throw AppError.forbidden("Only the group owner or the sender can pin a message");
  }

  const [updated] = await db
    .update(messages)
    .set({ pinnedAt: input.pinned ? new Date() : null })
    .where(eq(messages.id, row.message.id))
    .returning();
  return updated ?? row.message;
}

/**
 * 나에게만 메시지를 숨긴다. 메시지·봉투·첨부는 삭제하지 않고,
 * 해당 사용자의 이력/읽지 않은 수/마지막 메시지 계산에서만 제외한다.
 */
export async function hideMessageForUser(
  db: Database,
  input: { conversationId: string; messageId: string; userId: string },
): Promise<void> {
  const [message] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(messages.conversationId, input.conversationId),
      ),
    )
    .limit(1);
  if (!message) {
    throw AppError.notFound("MESSAGE_NOT_FOUND", "Message not found");
  }
  await db
    .insert(messageDeletions)
    .values({ messageId: input.messageId, userId: input.userId })
    .onConflictDoNothing();
}

export async function getMessageViewForDevice(
  db: Database,
  input: { messageId: string; deviceId: string },
): Promise<MessageView | null> {
  const [row] = await db
    .select({ message: messages, key: messageKeys })
    .from(messages)
    .leftJoin(
      messageKeys,
      and(
        eq(messageKeys.messageId, messages.id),
        eq(messageKeys.recipientDeviceId, input.deviceId),
      ),
    )
    .where(eq(messages.id, input.messageId))
    .limit(1);
  return row ? toMessageView(row.message, row.key) : null;
}

export async function countMessages(db: Database, conversationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return row?.count ?? 0;
}
