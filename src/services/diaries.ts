import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import {
  deviceOneTimePreKeys,
  devices,
  diaryAudience,
  diaryEntries,
  diaryEntryKeys,
  diaries,
  users,
} from "../db/schema.js";
import { normalizeMessagePayload } from "../crypto/envelope.js";
import { AppError } from "../http/errors.js";

/**
 * 일기장(공유 다이어리). 만료 없음 · 대상 한정 · 대상 변경 시 키 세대 회전(정책 B).
 * 본문(에디터 HTML)은 ciphertext 안에만 있고 서버는 복호화하지 않는다.
 */

export const MAX_DIARY_AUDIENCE = 20;
export const MAX_DIARY_LABEL = 40;
export const DEFAULT_ENTRY_LIMIT = 30;

export interface DiaryDevice {
  id: string;
  name: string;
  identityPublicKey: string;
  signedPreKeyId: string | null;
  signedPreKeyPublicKey: string | null;
  signedPreKeySignature: string | null;
  oneTimePreKeyId: string | null;
  oneTimePreKeyPublicKey: string | null;
}

export interface DiaryMember {
  userId: string;
  username: string;
  isOwner: boolean;
  devices: DiaryDevice[];
}

async function validateAudienceUsers(
  db: Database,
  ownerUserId: string,
  audienceUserIds: string[],
): Promise<string[]> {
  const unique = [...new Set(audienceUserIds.filter((id) => id.length > 0))];
  if (unique.includes(ownerUserId)) {
    throw AppError.badRequest("INVALID_AUDIENCE", "Owner cannot be in the audience");
  }
  if (unique.length > MAX_DIARY_AUDIENCE) {
    throw AppError.badRequest("AUDIENCE_TOO_LARGE", "Too many audience members");
  }
  if (unique.length === 0) return [];
  const rows = await db.select({ id: users.id }).from(users).where(inArray(users.id, unique));
  if (rows.length !== unique.length) {
    throw AppError.badRequest("INVALID_AUDIENCE", "Unknown audience member");
  }
  return unique;
}

async function requireDiary(db: Database, diaryId: string, userId: string) {
  const [diary] = await db.select().from(diaries).where(eq(diaries.id, diaryId)).limit(1);
  if (!diary) throw AppError.notFound("DIARY_NOT_FOUND", "Diary not found");
  if (diary.ownerUserId === userId) return diary;
  const [member] = await db
    .select({ userId: diaryAudience.userId })
    .from(diaryAudience)
    .where(and(eq(diaryAudience.diaryId, diaryId), eq(diaryAudience.userId, userId)))
    .limit(1);
  if (!member) throw AppError.forbidden("You are not a member of this diary");
  return diary;
}

/** 참여자(소유자+대상)와 활성 기기. 클라이언트가 봉투를 만들 때 쓴다. */
async function loadMembers(db: Database, diaryId: string, ownerUserId: string) {
  const audience = await db
    .select({ userId: diaryAudience.userId })
    .from(diaryAudience)
    .where(eq(diaryAudience.diaryId, diaryId));
  const userIds = [ownerUserId, ...audience.map((row) => row.userId)];
  const people = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(inArray(users.id, userIds));
  const rows = await db
    .select({
      id: devices.id,
      userId: devices.userId,
      name: devices.name,
      identityPublicKey: devices.identityPublicKey,
      signedPreKeyId: devices.signedPreKeyId,
      signedPreKeyPublicKey: devices.signedPreKeyPublicKey,
      signedPreKeySignature: devices.signedPreKeySignature,
      opkId: deviceOneTimePreKeys.keyId,
      opkPublicKey: deviceOneTimePreKeys.publicKey,
    })
    .from(devices)
    .leftJoin(
      deviceOneTimePreKeys,
      and(eq(deviceOneTimePreKeys.deviceId, devices.id), isNull(deviceOneTimePreKeys.usedAt)),
    )
    .where(and(inArray(devices.userId, userIds), isNull(devices.revokedAt)));

  return userIds.map<DiaryMember>((userId) => ({
    userId,
    username: people.find((person) => person.id === userId)?.username ?? "",
    isOwner: userId === ownerUserId,
    devices: rows
      .filter((row) => row.userId === userId)
      .map((row) => ({
        id: row.id,
        name: row.name,
        identityPublicKey: row.identityPublicKey,
        signedPreKeyId: row.signedPreKeyId,
        signedPreKeyPublicKey: row.signedPreKeyPublicKey,
        signedPreKeySignature: row.signedPreKeySignature,
        oneTimePreKeyId: row.opkId,
        oneTimePreKeyPublicKey: row.opkPublicKey,
      })),
  }));
}

/** 내가 볼 수 있는 일기장 목록. */
export async function listDiaries(db: Database, userId: string) {
  const memberRows = await db
    .select({ diaryId: diaryAudience.diaryId })
    .from(diaryAudience)
    .where(eq(diaryAudience.userId, userId));
  const memberIds = memberRows.map((row) => row.diaryId);
  const ownerFilter = eq(diaries.ownerUserId, userId);
  const rows = await db
    .select({
      id: diaries.id,
      label: diaries.label,
      keyEpoch: diaries.keyEpoch,
      ownerUserId: diaries.ownerUserId,
      ownerUsername: users.username,
      updatedAt: diaries.updatedAt,
    })
    .from(diaries)
    .innerJoin(users, eq(users.id, diaries.ownerUserId))
    .where(
      memberIds.length > 0 ? or(ownerFilter, inArray(diaries.id, memberIds)) : ownerFilter,
    )
    .orderBy(desc(diaries.updatedAt));
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    keyEpoch: row.keyEpoch,
    ownerUserId: row.ownerUserId,
    ownerUsername: row.ownerUsername,
    isOwner: row.ownerUserId === userId,
    updatedAt: row.updatedAt.toISOString(),
  }));
}


/** 일기장 상세(참여자·기기 포함) — 대상 관리와 봉투 생성용. */
export async function getDiaryDetail(db: Database, diaryId: string, userId: string) {
  const diary = await requireDiary(db, diaryId, userId);
  const [row] = await db
    .select({ label: diaries.label, updatedAt: diaries.updatedAt })
    .from(diaries)
    .where(eq(diaries.id, diaryId))
    .limit(1);
  return {
    id: diary.id,
    label: row?.label ?? null,
    keyEpoch: diary.keyEpoch,
    ownerUserId: diary.ownerUserId,
    isOwner: diary.ownerUserId === userId,
    updatedAt: (row?.updatedAt ?? diary.updatedAt).toISOString(),
    members: await loadMembers(db, diaryId, diary.ownerUserId),
  };
}

/** 일기장 생성. */
export async function createDiary(
  db: Database,
  input: { ownerUserId: string; label?: string; audienceUserIds: string[] },
) {
  const label = input.label?.trim() ?? "";
  if (label.length > MAX_DIARY_LABEL) {
    throw AppError.badRequest("LABEL_TOO_LONG", "Diary label is too long");
  }
  const audienceUserIds = await validateAudienceUsers(db, input.ownerUserId, input.audienceUserIds);
  return db.transaction(async (tx) => {
    const [diary] = await tx
      .insert(diaries)
      .values({ ownerUserId: input.ownerUserId, label: label.length > 0 ? label : null })
      .returning({ id: diaries.id, keyEpoch: diaries.keyEpoch });
    if (!diary) throw new Error("Failed to create diary");
    if (audienceUserIds.length > 0) {
      await tx
        .insert(diaryAudience)
        .values(audienceUserIds.map((userId) => ({ diaryId: diary.id, userId, joinedEpoch: 1 })));
    }
    return { diaryId: diary.id, keyEpoch: diary.keyEpoch };
  });
}

/** 대상 변경 — 키 세대를 올린다(정책 B). */
export async function updateDiaryAudience(
  db: Database,
  input: { diaryId: string; ownerUserId: string; audienceUserIds: string[] },
) {
  const diary = await requireDiary(db, input.diaryId, input.ownerUserId);
  if (diary.ownerUserId !== input.ownerUserId) {
    throw AppError.forbidden("Only the diary owner can change the audience");
  }
  const nextAudience = await validateAudienceUsers(db, input.ownerUserId, input.audienceUserIds);
  const current = await db
    .select({ userId: diaryAudience.userId })
    .from(diaryAudience)
    .where(eq(diaryAudience.diaryId, input.diaryId));
  const currentIds = new Set(current.map((row) => row.userId));
  const nextIds = new Set(nextAudience);
  const removed = [...currentIds].filter((id) => !nextIds.has(id));
  const added = nextAudience.filter((id) => !currentIds.has(id));
  if (removed.length === 0 && added.length === 0) return { keyEpoch: diary.keyEpoch };

  const nextEpoch = diary.keyEpoch + 1;
  await db.transaction(async (tx) => {
    if (removed.length > 0) {
      await tx
        .delete(diaryAudience)
        .where(
          and(eq(diaryAudience.diaryId, input.diaryId), inArray(diaryAudience.userId, removed)),
        );
    }
    if (added.length > 0) {
      await tx
        .insert(diaryAudience)
        .values(added.map((userId) => ({ diaryId: input.diaryId, userId, joinedEpoch: nextEpoch })));
    }
    await tx
      .update(diaries)
      .set({ keyEpoch: nextEpoch, updatedAt: sql`now()` })
      .where(eq(diaries.id, input.diaryId));
  });
  return { keyEpoch: nextEpoch };
}

/** 글 목록 — 내 기기 봉투가 있는 글만. */
export async function listDiaryEntries(
  db: Database,
  input: { diaryId: string; userId: string; limit?: number },
) {
  await requireDiary(db, input.diaryId, input.userId);
  const myDevices = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.userId, input.userId), isNull(devices.revokedAt)));
  const deviceIds = myDevices.map((row) => row.id);
  if (deviceIds.length === 0) return [];

  const rows = await db
    .selectDistinct({
      id: diaryEntries.id,
      authorUserId: diaryEntries.authorUserId,
      authorUsername: users.username,
      keyEpoch: diaryEntries.keyEpoch,
      createdAt: diaryEntries.createdAt,
    })
    .from(diaryEntries)
    .innerJoin(diaryEntryKeys, eq(diaryEntryKeys.entryId, diaryEntries.id))
    .innerJoin(users, eq(users.id, diaryEntries.authorUserId))
    .where(
      and(
        eq(diaryEntries.diaryId, input.diaryId),
        inArray(diaryEntryKeys.recipientDeviceId, deviceIds),
      ),
    )
    .orderBy(desc(diaryEntries.createdAt))
    .limit(input.limit ?? DEFAULT_ENTRY_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    authorUserId: row.authorUserId,
    authorUsername: row.authorUsername,
    keyEpoch: row.keyEpoch,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** 글 1건(내 기기 봉투 포함). 봉투가 없으면 열람 불가. */
export async function getDiaryEntry(db: Database, entryId: string, userId: string) {
  const [row] = await db.select().from(diaryEntries).where(eq(diaryEntries.id, entryId)).limit(1);
  if (!row) throw AppError.notFound("ENTRY_NOT_FOUND", "Entry not found");
  await requireDiary(db, row.diaryId, userId);
  const myDevices = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
  if (myDevices.length === 0) {
    throw AppError.forbidden("이 기기에서는 이 글을 열 수 없습니다.");
  }
  const keys = await db
    .select()
    .from(diaryEntryKeys)
    .where(
      and(
        eq(diaryEntryKeys.entryId, entryId),
        inArray(
          diaryEntryKeys.recipientDeviceId,
          myDevices.map((device) => device.id),
        ),
      ),
    );
  if (keys.length === 0) {
    throw AppError.forbidden("이 기기에서는 이 글을 열 수 없습니다.");
  }
  return {
    id: row.id,
    diaryId: row.diaryId,
    authorUserId: row.authorUserId,
    authorDeviceId: row.authorDeviceId,
    authorSigningPublicKey: row.authorSigningPublicKey,
    keyEpoch: row.keyEpoch,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    signature: row.signature,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    keys: keys.map((key) => ({
      deviceId: key.recipientDeviceId,
      ephemeralPublicKey: key.ephemeralPublicKey,
      ratchetPublicKey: key.ratchetPublicKey,
      previousChainLength: key.previousChainLength,
      messageNumber: key.messageNumber,
      senderIdentityPublicKey: key.senderIdentityPublicKey,
      signedPreKeyId: key.signedPreKeyId,
      oneTimePreKeyId: key.oneTimePreKeyId,
      wrappedKey: key.wrappedKey,
      wrapNonce: key.wrapNonce,
      version: key.version,
    })),
  };
}


/** 글 작성 — 봉투는 현재 참여자(소유자 포함)의 활성 기기만 허용. */
export async function createDiaryEntry(
  db: Database,
  config: Config,
  input: {
    diaryId: string;
    authorUserId: string;
    authorDeviceId: string;
    clientEntryId: string;
    ciphertext: string;
    nonce: string;
    signature: string;
    keys: unknown;
  },
) {
  const diary = await requireDiary(db, input.diaryId, input.authorUserId);
  const members = await loadMembers(db, input.diaryId, diary.ownerUserId);
  const deviceUser = new Map<string, string>();
  for (const member of members) {
    for (const device of member.devices) deviceUser.set(device.id, member.userId);
  }

  const payload = normalizeMessagePayload(
    {
      clientMessageId: input.clientEntryId,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      signature: input.signature,
      keys: input.keys as never,
    },
    { maxCiphertextBytes: config.maxCiphertextBytes, maxEnvelopes: config.maxEnvelopes },
  );
  if (payload.keys.length === 0) {
    throw AppError.badRequest("INVALID_ENVELOPE", "At least one device envelope is required");
  }
  if (payload.keys.some((key) => key.distribution)) {
    throw AppError.badRequest("INVALID_ENVELOPE", "Sender-key distribution is not supported");
  }
  if (payload.keys.some((key) => !deviceUser.has(key.deviceId))) {
    throw AppError.badRequest("INVALID_ENVELOPE", "Envelope targets an unknown or inactive device");
  }
  if (!payload.keys.some((key) => key.deviceId === input.authorDeviceId)) {
    throw AppError.badRequest(
      "MISSING_AUTHOR_ENVELOPE",
      "Include an envelope for the author's current device",
    );
  }

  const [authorDevice] = await db
    .select({ signingPublicKey: devices.signingPublicKey })
    .from(devices)
    .where(eq(devices.id, input.authorDeviceId))
    .limit(1);
  if (!authorDevice) throw AppError.badRequest("INVALID_DEVICE", "Author device is unknown");

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(diaryEntries)
      .values({
        diaryId: input.diaryId,
        authorUserId: input.authorUserId,
        authorDeviceId: input.authorDeviceId,
        authorSigningPublicKey: authorDevice.signingPublicKey,
        keyEpoch: diary.keyEpoch,
        clientEntryId: input.clientEntryId,
        ciphertext: payload.ciphertext,
        nonce: payload.nonce,
        signature: payload.signature,
        recipientCount: new Set(payload.keys.map((key) => deviceUser.get(key.deviceId))).size,
      })
      .returning({ id: diaryEntries.id, createdAt: diaryEntries.createdAt });
    if (!entry) throw new Error("Failed to insert diary entry");

    await tx.insert(diaryEntryKeys).values(
      payload.keys.map((key) => ({
        entryId: entry.id,
        recipientDeviceId: key.deviceId,
        ephemeralPublicKey: key.version === 1 ? key.ephemeralPublicKey : null,
        ratchetPublicKey: key.version === 2 ? key.ratchetPublicKey : null,
        previousChainLength: key.version === 2 ? key.previousChainLength : null,
        messageNumber: key.version === 2 ? key.messageNumber : null,
        senderIdentityPublicKey: key.version === 2 ? (key.senderIdentityPublicKey ?? null) : null,
        signedPreKeyId: key.version === 2 ? (key.signedPreKeyId ?? null) : null,
        oneTimePreKeyId: key.version === 2 ? (key.oneTimePreKeyId ?? null) : null,
        wrappedKey: key.wrappedKey,
        wrapNonce: key.wrapNonce,
        version: key.version,
      })),
    );

    // v2 봉투가 사용한 원타임 프리키는 1회 소비한다(불변식 24).
    for (const key of payload.keys) {
      if (key.version !== 2 || !key.oneTimePreKeyId) continue;
      const [updated] = await tx
        .update(deviceOneTimePreKeys)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(deviceOneTimePreKeys.deviceId, key.deviceId),
            eq(deviceOneTimePreKeys.keyId, key.oneTimePreKeyId),
            isNull(deviceOneTimePreKeys.usedAt),
          ),
        )
        .returning({ keyId: deviceOneTimePreKeys.keyId });
      if (!updated) {
        throw AppError.conflict(
          "PREKEY_CONSUMED",
          "Unknown one-time prekey; refresh the device bundle",
        );
      }
    }

    await tx.update(diaries).set({ updatedAt: sql`now()` }).where(eq(diaries.id, input.diaryId));
    return { entryId: entry.id, keyEpoch: diary.keyEpoch, createdAt: entry.createdAt.toISOString() };
  });
}

/** 글 삭제 — 작성자 또는 일기장 소유자. */
export async function deleteDiaryEntry(db: Database, entryId: string, userId: string) {
  const [row] = await db
    .select({
      id: diaryEntries.id,
      diaryId: diaryEntries.diaryId,
      authorUserId: diaryEntries.authorUserId,
    })
    .from(diaryEntries)
    .where(eq(diaryEntries.id, entryId))
    .limit(1);
  if (!row) throw AppError.notFound("ENTRY_NOT_FOUND", "Entry not found");
  const diary = await requireDiary(db, row.diaryId, userId);
  if (row.authorUserId !== userId && diary.ownerUserId !== userId) {
    throw AppError.forbidden("Only the author or the diary owner can delete this entry");
  }
  await db.delete(diaryEntries).where(eq(diaryEntries.id, entryId));
  return { deleted: true };
}

