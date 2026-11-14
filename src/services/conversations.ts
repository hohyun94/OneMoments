import { and, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  conversationParticipants,
  conversationReads,
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
  peer: UserRow | null;
}

/** 그룹 최대 인원(생성자 포함). 기기 수가 MAX_ENVELOPES 를 넘지 않도록 보수적으로 제한한다. */
export const MAX_GROUP_MEMBERS = 20;

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

  let peer: UserRow | null = null;
  if (row.conversation.kind === "direct") {
    const [peerRow] = await db
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
    if (!peerRow) throw AppError.conflict("INVALID_CONVERSATION", "Conversation has no peer");
    peer = peerRow.user;
  }

  return { conversation: row.conversation, participant: row.participant, peer };
}

/** 나를 제외한 참여자(그룹 포함)를 가져온다. */
async function listConversationMembers(
  db: Database,
  conversationId: string,
  excludeUserId: string,
): Promise<UserRow[]> {
  const rows = await db
    .select({ user: users })
    .from(conversationParticipants)
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        ne(conversationParticipants.userId, excludeUserId),
      ),
    )
    .orderBy(users.createdAt, users.id);
  return rows.map((row) => row.user);
}

function normalizeGroupName(name: string): string {
  return name.trim();
}

function normalizeMemberIds(creatorUserId: string, memberUserIds: string[]): string[] {
  const unique = [...new Set(memberUserIds)];
  if (unique.length === 0 || unique.length > MAX_GROUP_MEMBERS - 1) {
    throw AppError.badRequest(
      "INVALID_GROUP_MEMBERS",
      `A group needs between 1 and ${MAX_GROUP_MEMBERS - 1} members`,
    );
  }
  if (unique.includes(creatorUserId)) {
    throw AppError.badRequest("INVALID_GROUP_MEMBERS", "You are already a participant");
  }
  return unique;
}

async function assertActiveUsers(db: Database, userIds: string[]): Promise<void> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, userIds), isNull(users.deletedAt)));
  if (rows.length !== userIds.length) {
    throw AppError.badRequest("USER_NOT_FOUND", "One or more users were not found");
  }
}

export async function createGroupConversation(
  db: Database,
  input: { creatorUserId: string; name: string; memberUserIds: string[] },
): Promise<ConversationRow> {
  const memberIds = normalizeMemberIds(input.creatorUserId, input.memberUserIds);
  await assertActiveUsers(db, memberIds);

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(conversations)
      .values({ kind: "group", name: normalizeGroupName(input.name) })
      .returning();
    if (!created) throw new Error("Failed to insert conversation");
    await tx.insert(conversationParticipants).values([
      { conversationId: created.id, userId: input.creatorUserId, role: "owner" },
      ...memberIds.map((userId) => ({
        conversationId: created.id,
        userId,
        role: "member",
      })),
    ]);
    return created;
  });
}

/** 그룹 owner만 참여자 추가·이름 변경을 할 수 있다. */
export async function requireGroupAdmin(
  db: Database,
  input: { conversationId: string; userId: string },
): Promise<ConversationContext> {
  const context = await requireParticipant(db, input);
  if (context.conversation.kind !== "group") {
    throw AppError.badRequest("NOT_GROUP_CONVERSATION", "Only group conversations have an owner");
  }
  if (context.participant.role !== "owner") {
    throw AppError.forbidden("Only the group owner can perform this action");
  }
  return context;
}

/** 그룹에 참여자를 추가한다. 이미 참여 중인 사용자는 무시한다(멱등). */
export async function addGroupMembers(
  db: Database,
  input: { conversationId: string; requesterUserId: string; userIds: string[] },
): Promise<{ conversation: ConversationRow; added: number }> {
  const context = await requireGroupAdmin(db, {
    conversationId: input.conversationId,
    userId: input.requesterUserId,
  });

  const unique = [...new Set(input.userIds)];
  if (unique.includes(input.requesterUserId)) {
    throw AppError.badRequest("INVALID_GROUP_MEMBERS", "You are already a participant");
  }

  const current = await listParticipantUserIds(db, input.conversationId);
  const existing = new Set(current);
  const toAdd = unique.filter((userId) => !existing.has(userId));
  if (toAdd.length === 0) return { conversation: context.conversation, added: 0 };
  if (current.length + toAdd.length > MAX_GROUP_MEMBERS) {
    throw AppError.conflict(
      "GROUP_FULL",
      `A group can have at most ${MAX_GROUP_MEMBERS} members`,
    );
  }
  await assertActiveUsers(db, toAdd);

  await db
    .insert(conversationParticipants)
    .values(toAdd.map((userId) => ({ conversationId: input.conversationId, userId })))
    .onConflictDoNothing();

  return { conversation: context.conversation, added: toAdd.length };
}

async function unreadCountFor(
  db: Database,
  input: { conversationId: string; userId: string; joinedAt: Date },
): Promise<number> {
  const [read] = await db
    .select({
      messageId: conversationReads.lastReadMessageId,
      updatedAt: conversationReads.updatedAt,
    })
    .from(conversationReads)
    .where(
      and(
        eq(conversationReads.conversationId, input.conversationId),
        eq(conversationReads.userId, input.userId),
      ),
    )
    .limit(1);

  const conditions = [
    eq(messages.conversationId, input.conversationId),
    ne(messages.senderUserId, input.userId),
  ];
  let hasCursor = false;
  if (read) {
    const cursorCreatedAt = db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, read.messageId));
    conditions.push(
      sql`(${messages.createdAt} > (${cursorCreatedAt}) or (${messages.createdAt} = (${cursorCreatedAt}) and ${messages.id} > ${read.messageId}))`,
    );
    hasCursor = true;
  }
  if (!hasCursor) {
    conditions.push(gte(messages.createdAt, input.joinedAt));
  }

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(...conditions));
  return row?.count ?? 0;
}

export async function markConversationRead(
  db: Database,
  input: { conversationId: string; userId: string; messageId: string },
): Promise<void> {
  const [message] = await db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(messages.conversationId, input.conversationId),
      ),
    )
    .limit(1);
  if (!message) {
    throw AppError.badRequest("INVALID_MESSAGE", "Message does not belong to this conversation");
  }

  const [existing] = await db
    .select({ messageId: conversationReads.lastReadMessageId })
    .from(conversationReads)
    .where(
      and(
        eq(conversationReads.conversationId, input.conversationId),
        eq(conversationReads.userId, input.userId),
      ),
    )
    .limit(1);
  if (existing) {
    const [cursor] = await db
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, existing.messageId))
      .limit(1);
    if (
      cursor &&
      (cursor.createdAt > message.createdAt ||
        (cursor.createdAt.getTime() === message.createdAt.getTime() &&
          cursor.id >= message.id))
    ) {
      return;
    }
  }

  await db
    .insert(conversationReads)
    .values({
      conversationId: input.conversationId,
      userId: input.userId,
      lastReadMessageId: input.messageId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [conversationReads.conversationId, conversationReads.userId],
      set: { lastReadMessageId: input.messageId, updatedAt: new Date() },
    });
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
  const members = await listConversationMembers(
    db,
    context.conversation.id,
    context.participant.userId,
  );
  return toConversationSummary(
    context.conversation,
    members,
    context.peer,
    members.length + 1,
    context.participant.mutedAt !== null,
    context.participant.role === "owner",
    await unreadCountFor(db, {
      conversationId: context.conversation.id,
      userId: context.participant.userId,
      joinedAt: context.participant.joinedAt,
    }),
    await lastMessageAt(db, context.conversation.id),
  );
}

export async function listConversations(
  db: Database,
  userId: string,
): Promise<ConversationSummary[]> {
  const rows = await db
    .select({ conversation: conversations, participant: conversationParticipants })
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

  const [participants, lastMessages] = await Promise.all([
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
      )
      .orderBy(users.createdAt, users.id),
    db
      .select({
        conversationId: messages.conversationId,
        lastMessageAt: sql<Date | string | null>`max(${messages.createdAt})`,
      })
      .from(messages)
      .where(inArray(messages.conversationId, conversationIds))
      .groupBy(messages.conversationId),
  ]);

  const membersByConversation = new Map<string, UserRow[]>();
  for (const row of participants) {
    const list = membersByConversation.get(row.conversationId) ?? [];
    list.push(row.user);
    membersByConversation.set(row.conversationId, list);
  }
  const lastByConversation = new Map(
    lastMessages.map((row) => [row.conversationId, row.lastMessageAt]),
  );

  const summaries: ConversationSummary[] = [];
  for (const row of rows) {
    const members = membersByConversation.get(row.conversation.id) ?? [];
    if (members.length === 0 && row.conversation.kind === "direct") continue;
    const peer = row.conversation.kind === "direct" ? (members[0] ?? null) : null;
    if (row.conversation.kind === "direct" && !peer) continue;
    summaries.push(
      toConversationSummary(
        row.conversation,
        members,
        peer,
        members.length + 1,
        row.participant.mutedAt !== null,
        row.participant.role === "owner",
        await unreadCountFor(db, {
          conversationId: row.conversation.id,
          userId,
          joinedAt: row.participant.joinedAt,
        }),
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

export async function listParticipantUserIds(
  db: Database,
  conversationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, conversationId));
  return rows.map((row) => row.userId);
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

export async function setConversationMuted(
  db: Database,
  input: { conversationId: string; userId: string; muted: boolean },
): Promise<boolean> {
  const [row] = await db
    .update(conversationParticipants)
    .set({ mutedAt: input.muted ? new Date() : null })
    .where(
      and(
        eq(conversationParticipants.conversationId, input.conversationId),
        eq(conversationParticipants.userId, input.userId),
      ),
    )
    .returning({ mutedAt: conversationParticipants.mutedAt });
  if (!row) throw AppError.notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
  return row.mutedAt !== null;
}

export async function listMutedParticipantUserIds(
  db: Database,
  conversationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        isNotNull(conversationParticipants.mutedAt),
      ),
    );
  return rows.map((row) => row.userId);
}

/** 그룹 이름 변경. 참여자만 가능하다. */
export async function renameGroup(
  db: Database,
  input: { conversationId: string; userId: string; name: string },
): Promise<ConversationRow> {
  await requireGroupAdmin(db, {
    conversationId: input.conversationId,
    userId: input.userId,
  });
  const [updated] = await db
    .update(conversations)
    .set({ name: normalizeGroupName(input.name) })
    .where(eq(conversations.id, input.conversationId))
    .returning();
  if (!updated) throw AppError.notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
  return updated;
}

/** 그룹 나가기. 마지막 참여자가 나가면 대화와 메시지를 삭제한다. */
export async function leaveGroup(
  db: Database,
  input: { conversationId: string; userId: string },
): Promise<{ deleted: boolean }> {
  const context = await requireParticipant(db, {
    conversationId: input.conversationId,
    userId: input.userId,
  });
  if (context.conversation.kind !== "group") {
    throw AppError.badRequest("NOT_GROUP_CONVERSATION", "Only group conversations can be left");
  }
  const wasOwner = context.participant.role === "owner";

  return db.transaction(async (tx) => {
    await tx
      .delete(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, input.conversationId),
          eq(conversationParticipants.userId, input.userId),
        ),
      );
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, input.conversationId));
    if ((row?.count ?? 0) === 0) {
      await tx.delete(conversations).where(eq(conversations.id, input.conversationId));
      return { deleted: true };
    }
    if (wasOwner) {
      const [nextOwner] = await tx
        .select({ userId: conversationParticipants.userId })
        .from(conversationParticipants)
        .where(eq(conversationParticipants.conversationId, input.conversationId))
        .orderBy(conversationParticipants.joinedAt, conversationParticipants.userId)
        .limit(1);
      if (nextOwner) {
        await tx
          .update(conversationParticipants)
          .set({ role: "owner" })
          .where(
            and(
              eq(conversationParticipants.conversationId, input.conversationId),
              eq(conversationParticipants.userId, nextOwner.userId),
            ),
          );
      }
    }
    return { deleted: false };
  });
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
