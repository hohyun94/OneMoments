import { randomBytes } from "node:crypto";

import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  devices,
  keyBackups,
  recoveryChallenges,
  users,
  type DeviceRow,
} from "../db/schema.js";
import { AppError } from "../http/errors.js";

export interface BackupRecord {
  blob: string;
  updatedAt: Date;
  deviceId: string;
}

async function activeDevice(
  db: Database,
  deviceId: string,
): Promise<DeviceRow | null> {
  const [device] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)))
    .limit(1);
  return device ?? null;
}

export async function upsertKeyBackup(
  db: Database,
  input: { userId: string; deviceId: string; blob: string },
): Promise<{ updatedAt: Date }> {
  const device = await activeDevice(db, input.deviceId);
  if (!device || device.userId !== input.userId) {
    throw AppError.forbidden("Device is not active");
  }

  const [row] = await db
    .insert(keyBackups)
    .values({
      userId: input.userId,
      deviceId: input.deviceId,
      blob: input.blob,
    })
    .onConflictDoUpdate({
      target: keyBackups.deviceId,
      set: { blob: input.blob, updatedAt: new Date() },
    })
    .returning({ updatedAt: keyBackups.updatedAt });

  if (!row) throw new Error("Failed to store key backup");
  return { updatedAt: row.updatedAt };
}

export async function getKeyBackupForDevice(
  db: Database,
  deviceId: string,
): Promise<BackupRecord | null> {
  const [row] = await db
    .select({
      blob: keyBackups.blob,
      updatedAt: keyBackups.updatedAt,
      deviceId: keyBackups.deviceId,
    })
    .from(keyBackups)
    .where(eq(keyBackups.deviceId, deviceId))
    .limit(1);
  return row ?? null;
}

/** 복구 화면에서 username으로 최신 백업을 찾는다(블롭은 클라이언트 암호문). */
export async function findLatestBackupByUsername(
  db: Database,
  username: string,
): Promise<BackupRecord | null> {
  const [row] = await db
    .select({
      blob: keyBackups.blob,
      updatedAt: keyBackups.updatedAt,
      deviceId: keyBackups.deviceId,
    })
    .from(keyBackups)
    .innerJoin(users, eq(users.id, keyBackups.userId))
    .where(and(eq(users.username, username), isNull(users.deletedAt)))
    .orderBy(desc(keyBackups.updatedAt))
    .limit(1);
  return row ?? null;
}

export interface RecoveryChallenge {
  challengeId: string;
  challenge: string;
  expiresAt: Date;
}

export async function createRecoveryChallenge(
  db: Database,
  input: { deviceId: string; ttlSeconds: number },
): Promise<RecoveryChallenge | null> {
  const device = await activeDevice(db, input.deviceId);
  if (!device) return null;

  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  const [row] = await db
    .insert(recoveryChallenges)
    .values({ deviceId: input.deviceId, nonce, expiresAt })
    .returning({ id: recoveryChallenges.id });

  if (!row) throw new Error("Failed to create recovery challenge");
  return { challengeId: row.id, challenge: nonce, expiresAt };
}

export async function consumeRecoveryChallenge(
  db: Database,
  input: { challengeId: string; deviceId: string },
): Promise<{ nonce: string } | null> {
  const [row] = await db
    .select({ nonce: recoveryChallenges.nonce })
    .from(recoveryChallenges)
    .where(
      and(
        eq(recoveryChallenges.id, input.challengeId),
        eq(recoveryChallenges.deviceId, input.deviceId),
        gt(recoveryChallenges.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;

  // 한 번만 사용할 수 있도록 즉시 삭제한다.
  await db.delete(recoveryChallenges).where(eq(recoveryChallenges.id, input.challengeId));
  return { nonce: row.nonce };
}

export async function findDeviceForRecovery(
  db: Database,
  deviceId: string,
): Promise<DeviceRow | null> {
  return activeDevice(db, deviceId);
}

export async function deleteExpiredRecoveryChallenges(db: Database): Promise<void> {
  await db.delete(recoveryChallenges).where(lt(recoveryChallenges.expiresAt, new Date()));
}
