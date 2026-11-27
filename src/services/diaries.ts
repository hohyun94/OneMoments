import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import {
  deviceOneTimePreKeys,
  devices,
  diaryAttachments,
  diaryAudience,
  diaryEntries,
  diaryEntryKeys,
  diaryEntryVersions,
  diaries,
  users,
} from "../db/schema.js";
import { normalizeMessagePayload } from "../crypto/envelope.js";
import type { AttachmentStorage } from "./attachments.js";
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
    devices: [...new Map(rows.filter((row) => row.userId === userId).map((row) => [row.id, row])).values()]
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



/** 사진 업로드 — 암호문 블롭을 저장하고 id/size 만 돌려준다. */
export async function createDiaryAttachment(
  db: Database,
  storage: AttachmentStorage,
  input: { uploaderUserId: string; clientEntryId: string | null; data: Buffer },
) {
  const id = randomUUID();
  await storage.put(id, input.data);
  try {
    const [row] = await db
      .insert(diaryAttachments)
      .values({
        id,
        uploaderUserId: input.uploaderUserId,
        clientEntryId: input.clientEntryId,
        size: input.data.byteLength,
      })
      .returning();
    if (!row) throw new Error("Failed to insert diary attachment");
    return row;
  } catch (error) {
    await storage.delete(id);
    throw error;
  }
}

/** 첨부 접근 — 글에 연결됐으면 그 일기장 멤버만, 아직 예약 상태면 업로더만. */
export async function requireDiaryAttachmentAccess(
  db: Database,
  input: { attachmentId: string; userId: string },
) {
  const [row] = await db
    .select({ attachment: diaryAttachments, entry: diaryEntries })
    .from(diaryAttachments)
    .leftJoin(diaryEntries, eq(diaryEntries.id, diaryAttachments.entryId))
    .where(eq(diaryAttachments.id, input.attachmentId))
    .limit(1);
  if (!row) throw AppError.notFound("ATTACHMENT_NOT_FOUND", "Attachment not found");
  if (!row.entry) {
    if (row.attachment.uploaderUserId !== input.userId) {
      throw AppError.notFound("ATTACHMENT_NOT_FOUND", "Attachment not found");
    }
    return row.attachment;
  }
  await requireDiary(db, row.entry.diaryId, input.userId);
  return row.attachment;
}

/** 일기장 이름 변경(소유자). */
export async function renameDiary(
  db: Database,
  input: { diaryId: string; ownerUserId: string; label?: string },
) {
  const diary = await requireDiary(db, input.diaryId, input.ownerUserId);
  if (diary.ownerUserId !== input.ownerUserId) {
    throw AppError.forbidden("Only the diary owner can rename this diary");
  }
  const label = input.label?.trim() ?? "";
  if (label.length > MAX_DIARY_LABEL) {
    throw AppError.badRequest("LABEL_TOO_LONG", "Diary label is too long");
  }
  await db
    .update(diaries)
    .set({ label: label.length > 0 ? label : null, updatedAt: sql`now()` })
    .where(eq(diaries.id, input.diaryId));
  return { diaryId: input.diaryId, label: label.length > 0 ? label : null };
}

/** 일기장 삭제(소유자). 글·대상·첨부 행은 cascade 로 함께 지워진다. */
export async function deleteDiary(
  db: Database,
  input: { diaryId: string; ownerUserId: string },
) {
  const diary = await requireDiary(db, input.diaryId, input.ownerUserId);
  if (diary.ownerUserId !== input.ownerUserId) {
    throw AppError.forbidden("Only the diary owner can delete this diary");
  }
  await db.delete(diaries).where(eq(diaries.id, input.diaryId));
  return { deleted: true };
}

/**
 * 글에 연결되지 않은 채 남은 첨부(업로드만 하고 저장하지 않은 사진)를 정리한다.
 *
 * 서버는 첨부의 성격을 모르므로 **나이(기본 24시간)** 만 기준으로 지운다.
 * 저장된 글의 첨부는 `entryId` 가 있어 대상이 아니다.
 */
export async function cleanupOrphanDiaryAttachments(
  db: Database,
  storage: AttachmentStorage,
  olderThanHours = 24,
): Promise<{ removed: number }> {
  const rows = await db
    .select({ id: diaryAttachments.id })
    .from(diaryAttachments)
    .where(
      and(
        isNull(diaryAttachments.entryId),
        sql`${diaryAttachments.createdAt} < now() - (${olderThanHours} || ' hours')::interval`,
      ),
    )
    .limit(200);
  for (const row of rows) {
    await db.delete(diaryAttachments).where(eq(diaryAttachments.id, row.id));
    await storage.delete(row.id).catch(() => undefined);
  }
  return { removed: rows.length };
}

/**
 * 글 수정 — **작성자만**. 본문을 다시 암호화해 **봉투까지 함께 교체**한다.
 *
 * 글마다 새 콘텐츠 키를 쓰는 구조라, 본문만 바꾸면 기존 봉투로는 풀 수 없다.
 * 그래서 생성과 같은 규칙(현재 참여자 활성 기기 검증)으로 봉투를 다시 받아
 * `diary_entry_keys` 를 통째로 교체한다. 키 세대(`keyEpoch`)는 그대로 둔다.
 */
export async function updateDiaryEntry(
  db: Database,
  config: Config,
  input: {
    entryId: string;
    userId: string;
    ciphertext: string;
    nonce: string;
    signature: string;
    keys: unknown;
  },
) {
  const [row] = await db
    .select({
      id: diaryEntries.id,
      diaryId: diaryEntries.diaryId,
      authorUserId: diaryEntries.authorUserId,
      keyEpoch: diaryEntries.keyEpoch,
    })
    .from(diaryEntries)
    .where(eq(diaryEntries.id, input.entryId))
    .limit(1);
  if (!row) throw AppError.notFound("ENTRY_NOT_FOUND", "Entry not found");
  const diary = await requireDiary(db, row.diaryId, input.userId);
  if (row.authorUserId !== input.userId) {
    throw AppError.forbidden("Only the author can edit this entry");
  }

  const members = await loadMembers(db, row.diaryId, diary.ownerUserId);
  const deviceUser = new Map<string, string>();
  for (const member of members) {
    for (const device of member.devices) deviceUser.set(device.id, member.userId);
  }
  const payload = normalizeMessagePayload(
    {
      clientMessageId: input.entryId,
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
  if (payload.keys.some((key) => key.distribution || !deviceUser.has(key.deviceId))) {
    throw AppError.badRequest("INVALID_ENVELOPE", "Envelope targets an unknown or inactive device");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(diaryEntries)
      .set({
        ciphertext: payload.ciphertext,
        nonce: payload.nonce,
        signature: payload.signature,
        recipientCount: new Set(payload.keys.map((key) => deviceUser.get(key.deviceId))).size,
        updatedAt: sql`now()`,
      })
      .where(eq(diaryEntries.id, input.entryId));
    await snapshotEntryVersion(tx, input.entryId, input.userId);
    await tx.delete(diaryEntryKeys).where(eq(diaryEntryKeys.entryId, input.entryId));
    await tx.insert(diaryEntryKeys).values(
      payload.keys.map((key) => ({
        entryId: input.entryId,
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
  });
  return { entryId: input.entryId, keyEpoch: row.keyEpoch };
}

/** 수정 직전 상태를 이력으로 남긴다(그 시점 봉투 포함). */
async function snapshotEntryVersion(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  entryId: string,
  editorUserId: string,
): Promise<void> {
  const [current] = await tx
    .select({
      ciphertext: diaryEntries.ciphertext,
      nonce: diaryEntries.nonce,
      signature: diaryEntries.signature,
      keyEpoch: diaryEntries.keyEpoch,
    })
    .from(diaryEntries)
    .where(eq(diaryEntries.id, entryId))
    .limit(1);
  if (!current) return;
  const keys = await tx
    .select()
    .from(diaryEntryKeys)
    .where(eq(diaryEntryKeys.entryId, entryId));
  const [versionRow] = await tx
    .select({
      nextNo: sql<number>`coalesce(max(${diaryEntryVersions.versionNo}), 0) + 1`,
    })
    .from(diaryEntryVersions)
    .where(eq(diaryEntryVersions.entryId, entryId));
  await tx.insert(diaryEntryVersions).values({
    entryId,
    versionNo: Number(versionRow?.nextNo ?? 1),
    ciphertext: current.ciphertext,
    nonce: current.nonce,
    signature: current.signature,
    keyEpoch: current.keyEpoch,
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
    editedByUserId: editorUserId,
  });
}

/** 글 이력 목록(메타데이터만, 최신순). */
export async function listDiaryEntryVersions(db: Database, entryId: string, userId: string) {
  const [entry] = await db
    .select({ diaryId: diaryEntries.diaryId })
    .from(diaryEntries)
    .where(eq(diaryEntries.id, entryId))
    .limit(1);
  if (!entry) throw AppError.notFound("ENTRY_NOT_FOUND", "Entry not found");
  await requireDiary(db, entry.diaryId, userId);
  const rows = await db
    .select({
      id: diaryEntryVersions.id,
      versionNo: diaryEntryVersions.versionNo,
      keyEpoch: diaryEntryVersions.keyEpoch,
      createdAt: diaryEntryVersions.createdAt,
    })
    .from(diaryEntryVersions)
    .where(eq(diaryEntryVersions.entryId, entryId))
    .orderBy(desc(diaryEntryVersions.versionNo));
  return rows.map((row) => ({
    id: row.id,
    versionNo: row.versionNo,
    keyEpoch: row.keyEpoch,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** 이력 1건(그 시점 봉투 포함) — 내 기기 봉투가 있는 것만 내려준다. */
export async function getDiaryEntryVersion(
  db: Database,
  input: { entryId: string; versionId: string; userId: string },
) {
  const [entry] = await db
    .select({ diaryId: diaryEntries.diaryId, authorSigningPublicKey: diaryEntries.authorSigningPublicKey })
    .from(diaryEntries)
    .where(eq(diaryEntries.id, input.entryId))
    .limit(1);
  if (!entry) throw AppError.notFound("ENTRY_NOT_FOUND", "Entry not found");
  await requireDiary(db, entry.diaryId, input.userId);
  const [version] = await db
    .select()
    .from(diaryEntryVersions)
    .where(eq(diaryEntryVersions.id, input.versionId))
    .limit(1);
  if (!version || version.entryId !== input.entryId) {
    throw AppError.notFound("VERSION_NOT_FOUND", "Version not found");
  }
  const myDevices = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.userId, input.userId), isNull(devices.revokedAt)));
  const deviceIds = new Set(myDevices.map((device) => device.id));
  const keys = (version.keys as Array<{ deviceId: string }>).filter((key) =>
    deviceIds.has(key.deviceId),
  );
  if (keys.length === 0) {
    throw AppError.forbidden("이 기기에서는 이 버전을 열 수 없습니다.");
  }
  return {
    id: version.id,
    entryId: version.entryId,
    versionNo: version.versionNo,
    authorSigningPublicKey: entry.authorSigningPublicKey,
    keyEpoch: version.keyEpoch,
    ciphertext: version.ciphertext,
    nonce: version.nonce,
    signature: version.signature,
    createdAt: version.createdAt.toISOString(),
    keys,
  };
}

