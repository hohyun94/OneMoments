import { randomBytes } from "node:crypto";

import { and, desc, eq, isNull } from "drizzle-orm";

import { hashPassword, verifyPassword } from "../auth/password.js";
import type { Database } from "../db/client.js";
import { loginProfiles, users } from "../db/schema.js";
import { AppError } from "../http/errors.js";
import { recordAdminAudit } from "./admin.js";

/**
 * decoy 프로필 관리(관리자 전용).
 * 비밀번호 원문은 저장·응답·로그 어디에도 남기지 않고 해시만 다룬다.
 */

const HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/;

export interface DecoyProfileView {
  id: string;
  alias: string;
  userId: string;
  handle: string;
  disabledAt: string | null;
  createdAt: string;
}

export interface AdminActor {
  adminUserId: string;
  adminUsername: string;
}

function toView(
  profile: typeof loginProfiles.$inferSelect,
  handle: string,
): DecoyProfileView {
  return {
    id: profile.id,
    alias: profile.alias,
    userId: profile.userId,
    handle,
    disabledAt: profile.disabledAt ? profile.disabledAt.toISOString() : null,
    createdAt: profile.createdAt.toISOString(),
  };
}

export async function listDecoyProfiles(db: Database): Promise<DecoyProfileView[]> {
  const rows = await db
    .select({ profile: loginProfiles, handle: users.username })
    .from(loginProfiles)
    .innerJoin(users, eq(users.id, loginProfiles.userId))
    .orderBy(desc(loginProfiles.createdAt));
  return rows.map((row) => toView(row.profile, row.handle));
}

export async function createDecoyProfile(
  db: Database,
  input: AdminActor & { alias: string; handle?: string; password: string },
): Promise<DecoyProfileView> {
  const alias = input.alias.trim().toLowerCase();

  const [real] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, alias), isNull(users.deletedAt)))
    .limit(1);
  if (!real) throw AppError.notFound("ALIAS_NOT_FOUND", "Real account not found");

  const [existing] = await db
    .select({ id: loginProfiles.id })
    .from(loginProfiles)
    .where(eq(loginProfiles.alias, alias))
    .limit(1);
  if (existing) {
    throw AppError.conflict("DECOY_EXISTS", "Decoy profile already exists for this account");
  }

  if (await verifyPassword(input.password, real.passwordHash)) {
    throw AppError.badRequest(
      "DECOY_PASSWORD_SAME",
      "Decoy password must differ from the real password",
    );
  }

  const handle = input.handle?.trim().toLowerCase() || `decoy_${randomBytes(4).toString("hex")}`;
  if (!HANDLE_PATTERN.test(handle)) {
    throw AppError.badRequest(
      "INVALID_HANDLE",
      "Handle must be 3-32 characters: letters, digits, dot, dash, underscore",
    );
  }
  const [handleOwner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, handle))
    .limit(1);
  if (handleOwner) throw AppError.conflict("HANDLE_TAKEN", "Username is already taken");

  const decoyPasswordHash = await hashPassword(input.password);
  const randomPasswordHash = await hashPassword(randomBytes(32).toString("base64url"));

  const created = await db.transaction(async (tx) => {
    const [decoyUser] = await tx
      .insert(users)
      .values({ username: handle, passwordHash: randomPasswordHash })
      .returning();
    if (!decoyUser) throw new Error("Failed to create decoy user");
    const [profile] = await tx
      .insert(loginProfiles)
      .values({
        alias,
        userId: decoyUser.id,
        passwordHash: decoyPasswordHash,
        kind: "decoy",
      })
      .returning();
    if (!profile) throw new Error("Failed to create decoy profile");
    await recordAdminAudit(tx, {
      adminUserId: input.adminUserId,
      adminUsername: input.adminUsername,
      action: "decoy.created",
      targetUserId: decoyUser.id,
      targetUsername: handle,
      detail: { alias },
    });
    return { profile, handle };
  });

  return toView(created.profile, created.handle);
}

async function findProfileWithHandle(
  db: Database,
  profileId: string,
): Promise<{ profile: typeof loginProfiles.$inferSelect; handle: string }> {
  const [row] = await db
    .select({ profile: loginProfiles, handle: users.username })
    .from(loginProfiles)
    .innerJoin(users, eq(users.id, loginProfiles.userId))
    .where(eq(loginProfiles.id, profileId))
    .limit(1);
  if (!row) throw AppError.notFound("DECOY_NOT_FOUND", "Decoy profile not found");
  return row;
}

export async function rotateDecoyPassword(
  db: Database,
  input: AdminActor & { profileId: string; password: string },
): Promise<DecoyProfileView> {
  const existing = await findProfileWithHandle(db, input.profileId);

  const [real] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.username, existing.profile.alias))
    .limit(1);
  if (real && (await verifyPassword(input.password, real.passwordHash))) {
    throw AppError.badRequest(
      "DECOY_PASSWORD_SAME",
      "Decoy password must differ from the real password",
    );
  }

  const passwordHash = await hashPassword(input.password);
  const updated = await db.transaction(async (tx) => {
    const [profile] = await tx
      .update(loginProfiles)
      .set({ passwordHash, disabledAt: null })
      .where(eq(loginProfiles.id, input.profileId))
      .returning();
    if (!profile) throw AppError.notFound("DECOY_NOT_FOUND", "Decoy profile not found");
    await recordAdminAudit(tx, {
      adminUserId: input.adminUserId,
      adminUsername: input.adminUsername,
      action: "decoy.password.rotated",
      targetUserId: profile.userId,
      targetUsername: existing.handle,
      detail: { alias: profile.alias },
    });
    return profile;
  });

  return toView(updated, existing.handle);
}

export async function setDecoyProfileDisabled(
  db: Database,
  input: AdminActor & { profileId: string; disabled: boolean },
): Promise<DecoyProfileView> {
  const existing = await findProfileWithHandle(db, input.profileId);

  const updated = await db.transaction(async (tx) => {
    const [profile] = await tx
      .update(loginProfiles)
      .set({ disabledAt: input.disabled ? new Date() : null })
      .where(eq(loginProfiles.id, input.profileId))
      .returning();
    if (!profile) throw AppError.notFound("DECOY_NOT_FOUND", "Decoy profile not found");
    await recordAdminAudit(tx, {
      adminUserId: input.adminUserId,
      adminUsername: input.adminUsername,
      action: input.disabled ? "decoy.disabled" : "decoy.enabled",
      targetUserId: profile.userId,
      targetUsername: existing.handle,
      detail: { alias: profile.alias },
    });
    return profile;
  });

  return toView(updated, existing.handle);
}
