import {
  and,
  desc,
  eq,
  isNull,
} from "drizzle-orm";

import { hashPassword, verifyPassword } from "../auth/password.js";
import type { Database } from "../db/client.js";
import {
  devices,
  sessions,
  users,
  type DeviceRow,
  type SessionRow,
  type UserRow,
} from "../db/schema.js";
import { AppError } from "../http/errors.js";

export interface DeviceKeys {
  identityPublicKey: string;
  signingPublicKey: string;
}

export interface RegisterAccountInput extends DeviceKeys {
  username: string;
  password: string;
  deviceName: string;
}

function isUniqueViolation(error: unknown): boolean {
  // Drizzle 는 드라이버 오류를 DrizzleQueryError 로 감싸므로 cause 체인을 확인한다.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code?: unknown }).code === "23505"
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword("onemoments-dummy-password-value");
  return dummyHash;
}

export async function registerAccount(
  db: Database,
  input: RegisterAccountInput,
): Promise<{ user: UserRow; device: DeviceRow }> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ username: input.username, passwordHash })
        .returning();
      if (!user) throw new Error("Failed to insert user");

      const [device] = await tx
        .insert(devices)
        .values({
          userId: user.id,
          name: input.deviceName,
          identityPublicKey: input.identityPublicKey,
          signingPublicKey: input.signingPublicKey,
        })
        .returning();
      if (!device) throw new Error("Failed to insert device");
      return { user, device };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("USERNAME_TAKEN", "Username is already taken");
    }
    throw error;
  }
}

export async function verifyCredentials(
  db: Database,
  input: { username: string; password: string },
): Promise<UserRow> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, input.username))
    .limit(1);

  const storedHash = user?.passwordHash ?? (await getDummyHash());
  const passwordMatches = await verifyPassword(input.password, storedHash);
  if (!user || !passwordMatches || user.deletedAt !== null) {
    throw AppError.unauthorized("Invalid username or password");
  }
  return user;
}

export async function findActiveDevice(
  db: Database,
  input: { userId: string; deviceId: string },
): Promise<DeviceRow | null> {
  const [device] = await db
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.id, input.deviceId),
        eq(devices.userId, input.userId),
        isNull(devices.revokedAt),
      ),
    )
    .limit(1);
  return device ?? null;
}

export async function createSession(
  db: Database,
  input: {
    userId: string;
    deviceId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
  },
): Promise<SessionRow> {
  const [session] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      deviceId: input.deviceId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      userAgent: input.userAgent,
    })
    .returning();
  if (!session) throw new Error("Failed to insert session");
  return session;
}

export async function deleteSession(db: Database, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** 같은 기기에서 새로 로그인하면 이전 세션은 폐기한다(세션 회전). */
export async function deleteSessionsForDevice(
  db: Database,
  deviceId: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.deviceId, deviceId));
}

/**
 * 계정 익명화 삭제.
 * 세션·기기를 무효화하고 계정을 deleted_at 으로 표시하되, 메시지는 유지한다.
 * username 은 재사용할 수 없도록 행을 그대로 둔다(사칭 방지).
 */
export async function deleteAccount(
  db: Database,
  input: { userId: string; password: string },
): Promise<void> {
  const user = await findUserById(db, input.userId);
  if (!user || user.deletedAt !== null) {
    throw AppError.unauthorized("Unknown account");
  }
  const matches = await verifyPassword(input.password, user.passwordHash);
  if (!matches) throw AppError.unauthorized("Invalid password");

  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.userId, input.userId));
    await tx
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(and(eq(devices.userId, input.userId), isNull(devices.revokedAt)));
    await tx
      .update(users)
      .set({ deletedAt: new Date(), passwordHash: "deleted-account" })
      .where(eq(users.id, input.userId));
  });
}

export async function listDevices(db: Database, userId: string): Promise<DeviceRow[]> {
  return db
    .select()
    .from(devices)
    .where(eq(devices.userId, userId))
    .orderBy(desc(devices.createdAt));
}

export async function registerDevice(
  db: Database,
  input: { userId: string; name: string } & DeviceKeys,
): Promise<DeviceRow> {
  const [device] = await db
    .insert(devices)
    .values({
      userId: input.userId,
      name: input.name,
      identityPublicKey: input.identityPublicKey,
      signingPublicKey: input.signingPublicKey,
    })
    .returning();
  if (!device) throw new Error("Failed to insert device");
  return device;
}

/** 기기 폐기와 그 기기에 묶인 세션 삭제를 한 트랜잭션으로 처리한다. */
export async function revokeDevice(
  db: Database,
  input: { userId: string; deviceId: string },
): Promise<DeviceRow> {
  return db.transaction(async (tx) => {
    const [device] = await tx
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(devices.id, input.deviceId),
          eq(devices.userId, input.userId),
          isNull(devices.revokedAt),
        ),
      )
      .returning();
    if (!device) throw AppError.notFound("DEVICE_NOT_FOUND", "Device not found");
    await tx.delete(sessions).where(eq(sessions.deviceId, input.deviceId));
    return device;
  });
}

export async function findUserById(db: Database, userId: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return row ?? null;
}

export async function findUserByUsername(
  db: Database,
  username: string,
): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return row ?? null;
}

/** 정확 일치 검색. 삭제된 계정과 자기 자신은 제외한다. */
export async function searchUser(
  db: Database,
  input: { username: string; excludeUserId: string },
): Promise<UserRow | null> {
  const normalized = input.username.trim().toLowerCase();
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, normalized), isNull(users.deletedAt)))
    .limit(1);
  if (!row || row.id === input.excludeUserId) return null;
  return row;
}

export async function touchDevice(db: Database, deviceId: string): Promise<void> {
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, deviceId));
}
