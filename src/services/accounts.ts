import {
  and,
  desc,
  eq,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { hashPassword, verifyPassword } from "../auth/password.js";
import type { Database } from "../db/client.js";
import {
  deviceOneTimePreKeys,
  devices,
  loginProfiles,
  messageDeletions,
  pushSubscriptions,
  sessions,
  userBlocks,
  userFavorites,
  users,
  type DeviceRow,
  type SessionRow,
  type UserRow,
} from "../db/schema.js";
import { AppError } from "../http/errors.js";
import type { ThemeMode } from "../types/protocol.js";

export interface DeviceKeys {
  identityPublicKey: string;
  signingPublicKey: string;
  signedPreKey?: {
    id: string;
    publicKey: string;
    signature: string;
  } | null;
  oneTimePreKeys?: Array<{ id: string; publicKey: string }>;
}

export interface RegisterAccountInput extends DeviceKeys {
  username: string;
  password: string;
  deviceName: string;
}

export interface RegisterOAuthAccountInput extends DeviceKeys {
  username: string;
  provider: "google";
  subject: string;
  deviceName: string;
}

/** 기기 행 + 원타임 프리키를 같은 트랜잭션에 넣는다. */
async function insertDevice(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  input: DeviceKeys & { userId: string; deviceName: string },
): Promise<DeviceRow> {
  const [device] = await tx
    .insert(devices)
    .values({
      userId: input.userId,
      name: input.deviceName,
      identityPublicKey: input.identityPublicKey,
      signingPublicKey: input.signingPublicKey,
      signedPreKeyId: input.signedPreKey?.id ?? null,
      signedPreKeyPublicKey: input.signedPreKey?.publicKey ?? null,
      signedPreKeySignature: input.signedPreKey?.signature ?? null,
    })
    .returning();
  if (!device) throw new Error("Failed to insert device");
  if (input.oneTimePreKeys && input.oneTimePreKeys.length > 0) {
    await tx.insert(deviceOneTimePreKeys).values(
      input.oneTimePreKeys.map((key) => ({
        deviceId: device.id,
        keyId: key.id,
        publicKey: key.publicKey,
      })),
    );
  }
  return device;
}


function uniqueViolationConstraint(error: unknown): string | null {
  // Drizzle 는 드라이버 오류를 DrizzleQueryError 로 감싸므로 cause 체인을 확인한다.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (code === "23505") {
        const constraint = (current as { constraint?: unknown }).constraint;
        return typeof constraint === "string" ? constraint : "";
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return uniqueViolationConstraint(error) !== null;
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
      const device = await insertDevice(tx, { ...input, userId: user.id });
      return { user, device };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("USERNAME_TAKEN", "Username is already taken");
    }
    throw error;
  }
}

/**
 * Google OAuth 전용 계정 생성(비밀번호 없음).
 * 서버는 여전히 기기 공개키만 받고, 개인키는 브라우저에만 남는다.
 */
export async function registerOAuthAccount(
  db: Database,
  input: RegisterOAuthAccountInput,
): Promise<{ user: UserRow; device: DeviceRow }> {
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          username: input.username,
          passwordHash: null,
          oauthProvider: input.provider,
          oauthSubject: input.subject,
        })
        .returning();
      if (!user) throw new Error("Failed to insert user");
      const device = await insertDevice(tx, { ...input, userId: user.id });
      return { user, device };
    });
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === "users_oauth_uq") {
      throw AppError.conflict("OAUTH_ALREADY_LINKED", "This provider account is already linked");
    }
    if (constraint === "users_username_uq" || isUniqueViolation(error)) {
      throw AppError.conflict("USERNAME_TAKEN", "Username is already taken");
    }
    throw error;
  }
}

export interface VerifiedLogin {
  user: UserRow;
  profile: "real" | "decoy";
}

/**
 * 아이디 + 비밀번호를 실제 프로필 또는 decoy 프로필로 해석한다.
 * decoy 자격증명은 관리자 CLI로만 생성된다.
 */
export async function verifyLoginCredentials(
  db: Database,
  input: { username: string; password: string },
): Promise<VerifiedLogin> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, input.username))
    .limit(1);

  if (user && user.deletedAt === null) {
    // OAuth 전용 계정은 비밀번호가 없다. 존재 여부·응답 시간을 노출하지 않도록 더미 해시를 쓴다.
    const hash = user.passwordHash ?? (await getDummyHash());
    const matches = await verifyPassword(input.password, hash);
    if (user.passwordHash && matches) return { user, profile: "real" };
  }

  const [decoy] = await db
    .select({
      user: users,
      passwordHash: loginProfiles.passwordHash,
    })
    .from(loginProfiles)
    .innerJoin(users, eq(users.id, loginProfiles.userId))
    .where(
      and(
        eq(loginProfiles.alias, input.username),
        isNull(loginProfiles.disabledAt),
        eq(loginProfiles.kind, "decoy"),
      ),
    )
    .limit(1);

  if (decoy && decoy.user.deletedAt === null) {
    const matches = await verifyPassword(input.password, decoy.passwordHash);
    if (matches) return { user: decoy.user, profile: "decoy" };
  }

  // 존재 여부·프로필 종류를 노출하지 않는 공통 오류.
  throw AppError.unauthorized("Invalid username or password");
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

/** 기기 기본 무활동 로그아웃(초)을 변경한다. 본인 소유의 활성 기기만 허용한다. */
export async function updateDeviceIdleTimeout(
  db: Database,
  input: { userId: string; deviceId: string; seconds: number },
): Promise<DeviceRow> {
  const [device] = await db
    .update(devices)
    .set({ idleTimeoutSeconds: input.seconds })
    .where(
      and(
        eq(devices.id, input.deviceId),
        eq(devices.userId, input.userId),
        isNull(devices.revokedAt),
      ),
    )
    .returning();
  if (!device) throw AppError.notFound("DEVICE_NOT_FOUND", "Device not found");
  return device;
}

/** 이번 로그인(세션)에만 적용하는 오버라이드. null 이면 기기 기본값을 따른다. */
export async function updateSessionIdleTimeout(
  db: Database,
  input: { sessionId: string; seconds: number | null },
): Promise<SessionRow> {
  const [session] = await db
    .update(sessions)
    .set({ idleTimeoutSeconds: input.seconds })
    .where(eq(sessions.id, input.sessionId))
    .returning();
  if (!session) throw AppError.unauthorized("Session expired or invalid");
  return session;
}

/** 계정 화면 테마(모드·강조색)를 저장한다. */
export async function updateUserTheme(
  db: Database,
  input: { userId: string; mode: ThemeMode; accent: string },
): Promise<UserRow> {
  const [user] = await db
    .update(users)
    .set({ themeMode: input.mode, themeAccent: input.accent })
    .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
    .returning();
  if (!user) throw AppError.unauthorized("Unknown account");
  return user;
}

/** 공개 프로필 상태 메시지를 저장한다. null/빈 문자열이면 지운다. */
export async function updateUserStatus(
  db: Database,
  input: { userId: string; statusMessage: string | null },
): Promise<UserRow> {
  const [user] = await db
    .update(users)
    .set({ statusMessage: input.statusMessage })
    .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
    .returning();
  if (!user) throw AppError.unauthorized("Unknown account");
  return user;
}

/**
 * 계정 익명화 삭제.
 * 세션·기기를 무효화하고 계정을 deleted_at 으로 표시하되, 메시지는 유지한다.
 * username 은 재사용할 수 없도록 행을 그대로 둔다(사칭 방지).
 */
export async function deleteAccount(
  db: Database,
  input: { userId: string; password?: string; confirmUsername?: string },
): Promise<void> {
  const user = await findUserById(db, input.userId);
  if (!user || user.deletedAt !== null) {
    throw AppError.unauthorized("Unknown account");
  }
  if (user.passwordHash) {
    const matches = await verifyPassword(input.password ?? "", user.passwordHash);
    if (!matches) throw AppError.unauthorized("Invalid password");
  } else {
    // OAuth 전용 계정은 비밀번호가 없어 사용자명 입력으로 확인한다(세션+CSRF 는 이미 검증됨).
    if ((input.confirmUsername ?? "").trim().toLowerCase() !== user.username) {
      throw AppError.badRequest(
        "CONFIRM_REQUIRED",
        "Type your username to confirm account deletion",
      );
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.userId, input.userId));
    await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, input.userId));
    // 연락처 메타데이터(차단·즐겨찾기)도 함께 정리한다.
    await tx
      .delete(userBlocks)
      .where(
        or(
          eq(userBlocks.blockerUserId, input.userId),
          eq(userBlocks.blockedUserId, input.userId),
        ),
      );
    await tx
      .delete(userFavorites)
      .where(
        or(
          eq(userFavorites.userId, input.userId),
          eq(userFavorites.favoriteUserId, input.userId),
        ),
      );
    // 나에게만 삭제 메타데이터도 계정 익명화 시 정리한다.
    await tx
      .delete(messageDeletions)
      .where(eq(messageDeletions.userId, input.userId));
    await tx
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(and(eq(devices.userId, input.userId), isNull(devices.revokedAt)));
    await tx
      .update(users)
      .set({
        deletedAt: new Date(),
        passwordHash: "deleted-account",
        // Google 계정(sub)은 해제해 같은 Google 계정으로 새 계정을 만들 수 있게 한다.
        oauthProvider: null,
        oauthSubject: null,
        statusMessage: null,
      })
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
  return db.transaction(async (tx) => {
    const [device] = await tx
      .insert(devices)
      .values({
        userId: input.userId,
        name: input.name,
        identityPublicKey: input.identityPublicKey,
        signingPublicKey: input.signingPublicKey,
        signedPreKeyId: input.signedPreKey?.id ?? null,
        signedPreKeyPublicKey: input.signedPreKey?.publicKey ?? null,
        signedPreKeySignature: input.signedPreKey?.signature ?? null,
      })
      .returning();
    if (!device) throw new Error("Failed to insert device");
    if (input.oneTimePreKeys && input.oneTimePreKeys.length > 0) {
      await tx.insert(deviceOneTimePreKeys).values(
        input.oneTimePreKeys.map((key) => ({
          deviceId: device.id,
          keyId: key.id,
          publicKey: key.publicKey,
        })),
      );
    }
    return device;
  });
}

/** 사용하지 않은 원타임 프리키 수(클라이언트 보충 정책용). */
export async function countUnusedOneTimePreKeys(
  db: Database,
  deviceId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deviceOneTimePreKeys)
    .where(
      and(
        eq(deviceOneTimePreKeys.deviceId, deviceId),
        isNull(deviceOneTimePreKeys.usedAt),
      ),
    );
  return row?.count ?? 0;
}

/** 사용하지 않은 원타임 프리키 ID(클라이언트 보충·정리 정책용). */
export async function listUnusedOneTimePreKeyIds(
  db: Database,
  deviceId: string,
): Promise<string[]> {
  const rows = await db
    .select({ keyId: deviceOneTimePreKeys.keyId })
    .from(deviceOneTimePreKeys)
    .where(
      and(
        eq(deviceOneTimePreKeys.deviceId, deviceId),
        isNull(deviceOneTimePreKeys.usedAt),
      ),
    )
    .orderBy(deviceOneTimePreKeys.createdAt, deviceOneTimePreKeys.keyId);
  return rows.map((row) => row.keyId);
}

/** 새 원타임 프리키를 추가한다. 이미 존재하는 keyId는 무시한다. */
export async function addOneTimePreKeys(
  db: Database,
  input: { deviceId: string; keys: Array<{ id: string; publicKey: string }> },
): Promise<void> {
  if (input.keys.length === 0) return;
  await db
    .insert(deviceOneTimePreKeys)
    .values(
      input.keys.map((key) => ({
        deviceId: input.deviceId,
        keyId: key.id,
        publicKey: key.publicKey,
      })),
    )
    .onConflictDoNothing();
}

/** 기존 기기의 signed prekey만 갱신한다(키 백업/업그레이드 경로). */
export async function updateDeviceSignedPreKey(
  db: Database,
  input: {
    userId: string;
    deviceId: string;
    signedPreKey: NonNullable<DeviceKeys["signedPreKey"]>;
  },
): Promise<DeviceRow> {
  const [device] = await db
    .update(devices)
    .set({
      signedPreKeyId: input.signedPreKey.id,
      signedPreKeyPublicKey: input.signedPreKey.publicKey,
      signedPreKeySignature: input.signedPreKey.signature,
    })
    .where(
      and(
        eq(devices.id, input.deviceId),
        eq(devices.userId, input.userId),
        isNull(devices.revokedAt),
      ),
    )
    .returning();
  if (!device) throw AppError.unauthorized("Device revoked or unknown");
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
    await tx
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.deviceId, input.deviceId));
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

/** 제공자 계정(sub)으로 연결된 사용자를 찾는다. 삭제된 계정은 제외한다. */
export async function findUserByOAuthSubject(
  db: Database,
  input: { provider: "google"; subject: string },
): Promise<UserRow | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.oauthProvider, input.provider),
        eq(users.oauthSubject, input.subject),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 로그인한 사용자에게 제공자 계정을 연결한다. 이미 연결되어 있으면 그대로 둔다(멱등). */
export async function linkOAuthAccount(
  db: Database,
  input: { userId: string; provider: "google"; subject: string },
): Promise<UserRow> {
  const user = await findUserById(db, input.userId);
  if (!user || user.deletedAt !== null) throw AppError.unauthorized("Unknown account");
  if (user.oauthSubject) {
    if (user.oauthProvider === input.provider && user.oauthSubject === input.subject) return user;
    throw AppError.conflict("OAUTH_ALREADY_LINKED", "Account already has a linked provider");
  }
  try {
    const [updated] = await db
      .update(users)
      .set({ oauthProvider: input.provider, oauthSubject: input.subject })
      .where(and(eq(users.id, input.userId), isNull(users.oauthSubject)))
      .returning();
    if (!updated) {
      throw AppError.conflict("OAUTH_ALREADY_LINKED", "Account already has a linked provider");
    }
    return updated;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("OAUTH_ALREADY_LINKED", "This provider account is already linked");
    }
    throw error;
  }
}

/**
 * 제공자 연결을 해제한다. 비밀번호가 없는 계정은 잠기므로 거부한다(비밀번호 먼저 설정).
 * 비밀번호 확인은 세션 탈취 시 방어선이다.
 */
export async function unlinkOAuthAccount(
  db: Database,
  input: { userId: string; password: string },
): Promise<UserRow> {
  const user = await findUserById(db, input.userId);
  if (!user || user.deletedAt !== null) throw AppError.unauthorized("Unknown account");
  if (!user.oauthSubject) throw AppError.badRequest("OAUTH_NOT_LINKED", "No linked provider");
  if (!user.passwordHash) {
    throw AppError.badRequest(
      "PASSWORD_REQUIRED",
      "Set a password before unlinking the provider",
    );
  }
  const matches = await verifyPassword(input.password, user.passwordHash);
  if (!matches) throw AppError.unauthorized("Invalid password");
  const [updated] = await db
    .update(users)
    .set({ oauthProvider: null, oauthSubject: null })
    .where(eq(users.id, input.userId))
    .returning();
  if (!updated) throw AppError.unauthorized("Unknown account");
  return updated;
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
