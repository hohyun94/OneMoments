import { createHash, randomBytes } from "node:crypto";

import { and, count, eq } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  conversationInvites,
  conversationParticipants,
  conversations,
  type ConversationRow,
} from "../db/schema.js";
import { AppError } from "../http/errors.js";
import { MAX_GROUP_MEMBERS, requireGroupAdmin } from "./conversations.js";

const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreatedInvite {
  id: string;
  token: string;
  expiresAt: string;
  maxUses: number;
}

/** 그룹 소유자가 새 초대 링크를 만든다. 토큰 원문은 응답에서 한 번만 노출한다. */
export async function createConversationInvite(
  db: Database,
  input: {
    conversationId: string;
    userId: string;
    expiresInSeconds?: number | undefined;
    maxUses?: number | undefined;
  },
): Promise<CreatedInvite> {
  const context = await requireGroupAdmin(db, {
    conversationId: input.conversationId,
    userId: input.userId,
  });
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + (input.expiresInSeconds ?? INVITE_TTL_SECONDS) * 1000,
  );
  const [invite] = await db
    .insert(conversationInvites)
    .values({
      conversationId: context.conversation.id,
      createdByUserId: input.userId,
      tokenHash: hashToken(token),
      expiresAt,
      maxUses: input.maxUses ?? 10,
    })
    .returning();
  if (!invite) throw AppError.conflict("INVITE_CREATE_FAILED", "Could not create invite");
  return {
    id: invite.id,
    token,
    expiresAt: invite.expiresAt.toISOString(),
    maxUses: invite.maxUses,
  };
}

/** 초대 링크 수락. 이미 참여 중이면 멱등적으로 성공한다. */
export async function acceptConversationInvite(
  db: Database,
  input: { token: string; userId: string },
): Promise<{ conversation: ConversationRow }> {
  const tokenHash = hashToken(input.token);
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(conversationInvites)
      .where(eq(conversationInvites.tokenHash, tokenHash))
      .for("update")
      .limit(1);
    if (!invite || invite.revokedAt) {
      throw AppError.notFound("INVITE_INVALID", "Invite not found");
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new AppError(410, "INVITE_EXPIRED", "Invite has expired");
    }
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, invite.conversationId))
      .limit(1);
    if (!conversation || conversation.kind !== "group") {
      throw AppError.notFound("INVITE_INVALID", "Invite not found");
    }

    const [existing] = await tx
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, invite.conversationId),
          eq(conversationParticipants.userId, input.userId),
        ),
      )
      .limit(1);
    if (existing) return { conversation };

    if (invite.uses >= invite.maxUses) {
      throw new AppError(410, "INVITE_EXHAUSTED", "Invite has no remaining uses");
    }
    const [memberCount] = await tx
      .select({ value: count() })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, invite.conversationId));
    if ((memberCount?.value ?? 0) >= MAX_GROUP_MEMBERS) {
      throw AppError.conflict(
        "GROUP_FULL",
        `A group can have at most ${MAX_GROUP_MEMBERS} members`,
      );
    }

    await tx
      .update(conversationInvites)
      .set({ uses: invite.uses + 1 })
      .where(eq(conversationInvites.id, invite.id));
    await tx
      .insert(conversationParticipants)
      .values({ conversationId: invite.conversationId, userId: input.userId })
      .onConflictDoNothing();
    return { conversation };
  });
}
