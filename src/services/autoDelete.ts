import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  attachments,
  conversationParticipants,
  conversationReads,
  conversations,
  messageReads,
  messages,
  users,
} from "../db/schema.js";
import type { AttachmentStorage } from "./attachments.js";

/** 대화별 자동 삭제 허용 범위(1시간~30일). */
export const MIN_AUTO_DELETE_SECONDS = 60 * 60;
export const MAX_AUTO_DELETE_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_CLEANUP_BATCH = 200;

export interface CleanupAutoDeleteOptions {
  /** 테스트/배치 기준 시각. 기본값은 현재 시각. */
  now?: Date;
  /** 특정 대화만 정리한다. 없으면 자동 삭제가 켜진 모든 대화. */
  conversationId?: string;
  limit?: number;
}

export interface CleanupAutoDeleteResult {
  deletedMessages: number;
  deletedAttachments: number;
  conversations: number;
}

interface CandidateMessage {
  id: string;
  senderUserId: string;
  createdAt: Date;
}

interface Participant {
  userId: string;
  joinedAt: Date;
}

interface ReadCursor {
  userId: string;
  messageId: string;
  createdAt: Date;
  updatedAt: Date;
}

function cursorReached(cursor: ReadCursor, message: CandidateMessage): boolean {
  const cursorTime = cursor.createdAt.getTime();
  const messageTime = message.createdAt.getTime();
  if (cursorTime > messageTime) return true;
  if (cursorTime < messageTime) return false;
  return cursor.messageId >= message.id;
}

/**
 * "참여자 모두가 읽은 뒤 N일"이 지난 메시지를 삭제한다.
 *
 * - 읽은 시각은 message_reads 를 우선 쓰고, 없으면 현재 읽음 커서가 메시지에 도달한
 *   경우 커서 갱신 시각을 보수적으로 사용한다(기능 도입 이전 메시지 호환).
 * - 참여 이전 메시지와 내가 보낸 메시지는 읽음 대상에서 제외한다.
 * - 메시지를 지우기 전에 해당 메시지를 가리키는 읽음 커서를 남은 메시지로 보정한다.
 * - 첨부는 DB 행과 저장소 블롭을 함께 삭제한다.
 */
export async function cleanupAutoDeletedMessages(
  db: Database,
  storage: AttachmentStorage,
  options: CleanupAutoDeleteOptions = {},
): Promise<CleanupAutoDeleteResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? DEFAULT_CLEANUP_BATCH;

  const conversationRows = await db
    .select({
      id: conversations.id,
      retentionSeconds: conversations.autoDeleteAfterReadSeconds,
    })
    .from(conversations)
    .where(
      options.conversationId
        ? and(
            eq(conversations.id, options.conversationId),
            isNotNull(conversations.autoDeleteAfterReadSeconds),
          )
        : isNotNull(conversations.autoDeleteAfterReadSeconds),
    );

  let deletedMessages = 0;
  let deletedAttachments = 0;
  let touchedConversations = 0;

  for (const conversation of conversationRows) {
    const retentionSeconds = conversation.retentionSeconds;
    if (retentionSeconds === null) continue;
    const cutoff = new Date(now.getTime() - retentionSeconds * 1000);

    // 생성 시각만으로 후보를 줄인다. 읽은 시각은 생성 시각 이후이므로 이보다 오래된 것만 대상이다.
    const candidates = await db
      .select({
        id: messages.id,
        senderUserId: messages.senderUserId,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), lt(messages.createdAt, cutoff)))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(limit);

    if (candidates.length === 0) continue;

    const participants = await db
      .select({
        userId: conversationParticipants.userId,
        joinedAt: conversationParticipants.joinedAt,
      })
      .from(conversationParticipants)
      .innerJoin(users, eq(users.id, conversationParticipants.userId))
      .where(
        and(
          eq(conversationParticipants.conversationId, conversation.id),
          isNull(users.deletedAt),
        ),
      );

    const cursors = await db
      .select({
        userId: conversationReads.userId,
        messageId: conversationReads.lastReadMessageId,
        createdAt: messages.createdAt,
        updatedAt: conversationReads.updatedAt,
      })
      .from(conversationReads)
      .innerJoin(messages, eq(messages.id, conversationReads.lastReadMessageId))
      .where(eq(conversationReads.conversationId, conversation.id));

    const readRows = await db
      .select({
        messageId: messageReads.messageId,
        userId: messageReads.userId,
        readAt: messageReads.readAt,
      })
      .from(messageReads)
      .where(
        inArray(
          messageReads.messageId,
          candidates.map((message) => message.id),
        ),
      );

    const readsByMessage = new Map<string, Map<string, Date>>();
    for (const row of readRows) {
      const perMessage = readsByMessage.get(row.messageId) ?? new Map<string, Date>();
      perMessage.set(row.userId, row.readAt);
      readsByMessage.set(row.messageId, perMessage);
    }
    const cursorByUser = new Map(cursors.map((cursor) => [cursor.userId, cursor]));

    const deletable: CandidateMessage[] = [];
    for (const message of candidates) {
      const requiredReaders: Participant[] = participants.filter(
        (participant) =>
          participant.userId !== message.senderUserId &&
          participant.joinedAt.getTime() <= message.createdAt.getTime(),
      );

      let latestReadAt = message.createdAt;
      let allRead = true;
      for (const reader of requiredReaders) {
        const exact = readsByMessage.get(message.id)?.get(reader.userId) ?? null;
        const cursor = cursorByUser.get(reader.userId);
        const fallback =
          cursor && cursorReached(cursor, message) ? cursor.updatedAt : null;
        const readAt = exact ?? fallback;
        if (!readAt) {
          allRead = false;
          break;
        }
        if (readAt.getTime() > latestReadAt.getTime()) latestReadAt = readAt;
      }
      if (!allRead) continue;
      if (latestReadAt.getTime() + retentionSeconds * 1000 > now.getTime()) continue;
      deletable.push(message);
    }

    if (deletable.length === 0) continue;

    const messageIds = deletable.map((message) => message.id);
    const attachmentRows = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(inArray(attachments.messageId, messageIds));

    for (const attachment of attachmentRows) {
      await storage.delete(attachment.id).catch(() => undefined);
    }

    await db.transaction(async (tx) => {
      // 삭제되는 메시지를 가리키는 읽음 커서를 남은 메시지로 보정한다.
      const cursorRows = cursors.filter((cursor) => messageIds.includes(cursor.messageId));
      for (const cursor of cursorRows) {
        const [replacement] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversation.id),
              notInArray(messages.id, messageIds),
              sql`(
                ${messages.createdAt} < ${cursor.createdAt}
                or (
                  ${messages.createdAt} = ${cursor.createdAt}
                  and ${messages.id} <= ${cursor.messageId}::uuid
                )
              )`,
            ),
          )
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(1);

        if (replacement) {
          await tx
            .update(conversationReads)
            .set({ lastReadMessageId: replacement.id })
            .where(
              and(
                eq(conversationReads.conversationId, conversation.id),
                eq(conversationReads.userId, cursor.userId),
              ),
            );
        } else {
          await tx
            .delete(conversationReads)
            .where(
              and(
                eq(conversationReads.conversationId, conversation.id),
                eq(conversationReads.userId, cursor.userId),
              ),
            );
        }
      }

      if (attachmentRows.length > 0) {
        await tx
          .delete(attachments)
          .where(
            inArray(
              attachments.id,
              attachmentRows.map((attachment) => attachment.id),
            ),
          );
      }
      await tx.delete(messages).where(inArray(messages.id, messageIds));
    });

    deletedMessages += messageIds.length;
    deletedAttachments += attachmentRows.length;
    touchedConversations += 1;
  }

  return {
    deletedMessages,
    deletedAttachments,
    conversations: touchedConversations,
  };
}
