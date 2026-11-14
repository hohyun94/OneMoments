import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  conversationParticipants,
  conversations,
  devices,
  messages,
  users,
  type ConversationRow,
  type ParticipantRow,
  type UserRow,
} from "../db/schema.js";
import { AppError } from "../http/errors.js";
import { toConversationSummary } from "../http/serializers.js";
import type { ConversationSummary } from "../types/protocol.js";

export interface ConversationContext {
  conversation: ConversationRow;
  participant: ParticipantRow;
  peer: UserRow;
}

async function participantCount(db: Database, conversationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, conversationId));
  return row?.count ?? 0;
}

async function findDirectConversation(
  db: Database,
  userIds: [string, string],
): Promise<ConversationRow | null> {
  const candidates = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(
      conversationParticipants,
      eq(conversationParticipants.conversationId, conversations.id),
    )
    .where(
      and(
        eq(conversations.kind, "direct"),
        inArray(conversationParticipants.userId, userIds),
      ),
    )
    .groupBy(conversations.id)
    .having(sql`count(*) = 2`);

  for (const candidate of candidates) {
    if ((await participantCount(db, candidate.id)) !== 2) continue;
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, candidate.id))
      .limit(1);
    if (conversation) return conversation;
  }
  return null;
}

export async function findOrCreateDirectConversation(
  db: Database,
  input: { creatorUserId: string; peerUserId: string },
): Promise<{ conversation: ConversationRow; created: boolean }> {
  if (input.creatorUserId === input.peerUserId) {
    throw AppError.badRequest("CANNOT_MESSAGE_SELF", "You cannot start a conversation with yourself");
  }

  const [peer] = await db
    .select()
    .from(users)
    .where(eq(users.id, input.peerUserId))
    .limit(1);
  if (!peer || peer.deletedAt !== null) {
    throw AppError.notFound("USER_NOT_FOUND", "User not found");
  }

  const existing = await findDirectConversation(db, [
    input.creatorUserId,
    input.peerUserId,
  ]);
  if (existing) {
    // 숨겨 둔 대화를 다시 열면 목록에 나타난다.
    await db
      .update(conversationParticipants)
      .set({ hiddenAt: null })
      .where(
        and(
          eq(conversationParticipants.conversationId, existing.id),
          eq(conversationParticipants.userId, input.creatorUserId),
        ),
      );
    return { conversation: existing, created: false };
  }

  const conversation = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(conversations)
      .values({ kind: "direct" })
      .returning();
    if (!created) throw new Error("Failed to insert conversation");
    await tx.insert(conversationParticipants).values([
      { conversationId: created.id, userId: input.creatorUserId },
      { conversationId: created.id, userId: input.peerUserId },
    ]);
    return created;
  });

  return { conversation, created: true };
}

export async function requireParticipant(
  db: Database,
  input: { conversationId: string; userId: string },
): Promise<ConversationContext> {
  const [row] = await db
    .select({ conversation: conversations, participant: conversationParticipants })
    .from(conversationParticipants)
    .innerJoin(
      conversations,
      eq(conversations.id, conversationParticipants.conversationId),
    )
    .where(
      and(
        eq(conversationParticipants.conversationId, input.conversationId),
        eq(conversationParticipants.userId, input.userId),
      ),
    )
    .limit(1);

  // 비참여자에게 대화 존재 여부를 노출하지 않는다.
  if (!row) throw AppError.notFound("CONVERSATION_NOT_FOUND", "Conversation not found");

  const [peer] = await db
    .select({ user: users })
    .from(conversationParticipants)
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .where(
      and(
        eq(conversationParticipants.conversationId, input.conversationId),
        ne(conversationParticipants.userId, input.userId),
      ),
    )
    .limit(1);

  if (!peer) throw AppError.conflict("INVALID_CONVERSATION", "Conversation has no peer");
  return { conversation: row.conversation, participant: row.participant, peer: peer.user };
}

async function lastMessageAt(
  db: Database,
  conversationId: string,
): Promise<Date | string | null> {
  const [row] = await db
    .select({ lastMessageAt: sql<Date | string | null>`max(${messages.createdAt})` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return row?.lastMessageAt ?? null;
}

export async function getConversationSummary(
  db: Database,
  context: ConversationContext,
): Promise<ConversationSummary> {
  return toConversationSummary(
    context.conversation,
    context.peer,
    await lastMessageAt(db, context.conversation.id),
  );
}

export async function listConversations(
  db: Database,
  userId: string,
): Promise<ConversationSummary[]> {
  const rows = await db
    .select({ conversation: conversations })
    .from(conversationParticipants)
    .innerJoin(
      conversations,
      eq(conversations.id, conversationParticipants.conversationId),
    )
    .where(
      and(
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.hiddenAt),
      ),
    );

  if (rows.length === 0) return [];
  const conversationIds = rows.map((row) => row.conversation.id);

  const [peers, lastMessages] = await Promise.all([
    db
      .select({
        conversationId: conversationParticipants.conversationId,
        user: users,
      })
      .from(conversationParticipants)
      .innerJoin(users, eq(users.id, conversationParticipants.userId))
      .where(
        and(
          inArray(conversationParticipants.conversationId, conversationIds),
          ne(conversationParticipants.userId, userId),
        ),
      ),
    db
      .select({
        conversationId: messages.conversationId,
        lastMessageAt: sql<Date | string | null>`max(${messages.createdAt})`,
      })
      .from(messages)
      .where(inArray(messages.conversationId, conversationIds))
      .groupBy(messages.conversationId),
  ]);

  const peerByConversation = new Map(peers.map((row) => [row.conversationId, row.user]));
  const lastByConversation = new Map(
    lastMessages.map((row) => [row.conversationId, row.lastMessageAt]),
  );

  const summaries: ConversationSummary[] = [];
  for (const row of rows) {
    const peer = peerByConversation.get(row.conversation.id);
    if (!peer) continue;
    summaries.push(
      toConversationSummary(
        row.conversation,
        peer,
        lastByConversation.get(row.conversation.id) ?? null,
      ),
    );
  }

  return summaries.sort((a, b) => {
    const left = a.lastMessageAt ?? a.createdAt;
    const right = b.lastMessageAt ?? b.createdAt;
    return right.localeCompare(left);
  });
}

export interface ActiveDeviceKey {
  id: string;
  userId: string;
  identityPublicKey: string;
  signingPublicKey: string;
}

/** 암호화 대상: 두 참여자의 활성 기기 전체(발신자 자신의 다른 기기 포함). */
export async function listActiveDeviceKeys(
  db: Database,
  conversationId: string,
): Promise<ActiveDeviceKey[]> {
  const participants = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, conversationId));
  const userIds = participants.map((row) => row.userId);
  if (userIds.length === 0) return [];

  return db
    .select({
      id: devices.id,
      userId: devices.userId,
      identityPublicKey: devices.identityPublicKey,
      signingPublicKey: devices.signingPublicKey,
    })
    .from(devices)
    .where(and(inArray(devices.userId, userIds), isNull(devices.revokedAt)))
    .orderBy(devices.createdAt, devices.id);
}

export async function isParticipant(
  db: Database,
  input: { conversationId: string; userId: string },
): Promise<boolean> {
  const [row] = await db
    .select({ conversationId: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, input.conversationId),
        eq(conversationParticipants.userId, input.userId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function hideConversation(
  db: Database,
  input: { conversationId: string; userId: string },
): Promise<void> {
  await db
    .update(conversationParticipants)
    .set({ hiddenAt: new Date() })
    .where(
      and(
        eq(conversationParticipants.conversationId, input.conversationId),
        eq(conversationParticipants.userId, input.userId),
      ),
    );
}

export async function unhideConversation(
  db: Database,
  input: { conversationId: string; userId: string },
): Promise<void> {
  await db
    .update(conversationParticipants)
    .set({ hiddenAt: null })
    .where(
      and(
        eq(conversationParticipants.conversationId, input.conversationId),
        eq(conversationParticipants.userId, input.userId),
      ),
    );
}
