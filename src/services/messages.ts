import { and, desc, eq, lt, or, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
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
      return { message: existing, keys: existingKeys, created: false };
    }

    const keys = await tx
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
          wrappedKey: key.wrappedKey,
          wrapNonce: key.wrapNonce,
          version: key.version,
        })),
      )
      .returning();

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
  before?: string | undefined;
  limit: number;
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

  const rows = await db
    .select({ message: messages, key: messageKeys })
    .from(messages)
    .innerJoin(
      messageKeys,
      and(
        eq(messageKeys.messageId, messages.id),
        eq(messageKeys.recipientDeviceId, input.viewerDeviceId),
      ),
    )
    .where(
      and(
        eq(messages.conversationId, input.conversationId),
        cursor
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

export async function getMessageViewForDevice(
  db: Database,
  input: { messageId: string; deviceId: string },
): Promise<MessageView | null> {
  const [row] = await db
    .select({ message: messages, key: messageKeys })
    .from(messages)
    .innerJoin(
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
