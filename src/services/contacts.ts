import { and, eq, inArray, isNull, ne } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  conversationParticipants,
  userBlocks,
  userFavorites,
  users,
} from "../db/schema.js";
import { AppError } from "../http/errors.js";
import type { ContactView } from "../types/protocol.js";

/** 두 사용자가 같은 대화에 참여한 적이 있는지(대화 상대인지) 확인한다. */
export async function areContacts(
  db: Database,
  userId: string,
  targetUserId: string,
): Promise<boolean> {
  const theirConversations = db
    .select({ id: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.userId, targetUserId));
  const [row] = await db
    .select({ id: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.userId, userId),
        inArray(conversationParticipants.conversationId, theirConversations),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** 대화 상대 목록 + 상태 메시지/즐겨찾기/차단 상태. */
export async function listContacts(
  db: Database,
  userId: string,
): Promise<ContactView[]> {
  const conversationRows = await db
    .select({ conversationId: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.userId, userId));
  const conversationIds = conversationRows.map((row) => row.conversationId);
  if (conversationIds.length === 0) return [];

  const contactRows = await db
    .selectDistinct({
      id: users.id,
      username: users.username,
      statusMessage: users.statusMessage,
    })
    .from(conversationParticipants)
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .where(
      and(
        inArray(conversationParticipants.conversationId, conversationIds),
        ne(conversationParticipants.userId, userId),
        isNull(users.deletedAt),
      ),
    );
  const contactIds = contactRows.map((row) => row.id);
  if (contactIds.length === 0) return [];

  const [favorites, blocksByMe, blocksMe] = await Promise.all([
    db
      .select({ favoriteUserId: userFavorites.favoriteUserId })
      .from(userFavorites)
      .where(
        and(
          eq(userFavorites.userId, userId),
          inArray(userFavorites.favoriteUserId, contactIds),
        ),
      ),
    db
      .select({ blockedUserId: userBlocks.blockedUserId })
      .from(userBlocks)
      .where(
        and(
          eq(userBlocks.blockerUserId, userId),
          inArray(userBlocks.blockedUserId, contactIds),
        ),
      ),
    db
      .select({ blockerUserId: userBlocks.blockerUserId })
      .from(userBlocks)
      .where(
        and(
          eq(userBlocks.blockedUserId, userId),
          inArray(userBlocks.blockerUserId, contactIds),
        ),
      ),
  ]);
  const favoriteIds = new Set(favorites.map((row) => row.favoriteUserId));
  const blockedIds = new Set(blocksByMe.map((row) => row.blockedUserId));
  const blockedMeIds = new Set(blocksMe.map((row) => row.blockerUserId));

  return contactRows
    .map((row) => ({
      id: row.id,
      username: row.username,
      statusMessage: row.statusMessage,
      favorite: favoriteIds.has(row.id),
      blockedByMe: blockedIds.has(row.id),
      blockedMe: blockedMeIds.has(row.id),
    }))
    .sort((left, right) => {
      if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
      if (left.blockedByMe !== right.blockedByMe) return left.blockedByMe ? 1 : -1;
      return left.username.localeCompare(right.username);
    });
}

async function requireContact(
  db: Database,
  userId: string,
  targetUserId: string,
): Promise<void> {
  if (userId === targetUserId) {
    throw AppError.badRequest("INVALID_CONTACT", "Cannot change your own contact state");
  }
  if (!(await areContacts(db, userId, targetUserId))) {
    throw AppError.notFound("CONTACT_NOT_FOUND", "Contact not found");
  }
}

export async function setContactFavorite(
  db: Database,
  input: { userId: string; targetUserId: string; favorite: boolean },
): Promise<void> {
  await requireContact(db, input.userId, input.targetUserId);
  if (input.favorite) {
    await db
      .insert(userFavorites)
      .values({ userId: input.userId, favoriteUserId: input.targetUserId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(userFavorites)
      .where(
        and(
          eq(userFavorites.userId, input.userId),
          eq(userFavorites.favoriteUserId, input.targetUserId),
        ),
      );
  }
}

export async function setContactBlocked(
  db: Database,
  input: { userId: string; targetUserId: string; blocked: boolean },
): Promise<void> {
  await requireContact(db, input.userId, input.targetUserId);
  if (input.blocked) {
    await db
      .insert(userBlocks)
      .values({ blockerUserId: input.userId, blockedUserId: input.targetUserId })
      .onConflictDoNothing();
    // 차단하면 즐겨찾기는 의미가 없으므로 해제한다.
    await db
      .delete(userFavorites)
      .where(
        and(
          eq(userFavorites.userId, input.userId),
          eq(userFavorites.favoriteUserId, input.targetUserId),
        ),
      );
  } else {
    await db
      .delete(userBlocks)
      .where(
        and(
          eq(userBlocks.blockerUserId, input.userId),
          eq(userBlocks.blockedUserId, input.targetUserId),
        ),
      );
  }
}

/** 1:1에서의 차단 상태. 내가 차단했으면 me, 상대가 차단했으면 peer. */
export async function directBlockState(
  db: Database,
  userId: string,
  peerUserId: string,
): Promise<"me" | "peer" | null> {
  const [mine] = await db
    .select({ blockerUserId: userBlocks.blockerUserId })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerUserId, userId),
        eq(userBlocks.blockedUserId, peerUserId),
      ),
    )
    .limit(1);
  if (mine) return "me";
  const [theirs] = await db
    .select({ blockerUserId: userBlocks.blockerUserId })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerUserId, peerUserId),
        eq(userBlocks.blockedUserId, userId),
      ),
    )
    .limit(1);
  return theirs ? "peer" : null;
}

export async function isBlockedBetween(
  db: Database,
  firstUserId: string,
  secondUserId: string,
): Promise<boolean> {
  return (await directBlockState(db, firstUserId, secondUserId)) !== null;
}
