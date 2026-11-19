import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import type { Config } from "../config.js";
import { normalizeMessagePayload } from "../crypto/envelope.js";
import type { Database } from "../db/client.js";
import {
  conversationParticipants,
  deviceOneTimePreKeys,
  devices,
  momentAttachments,
  momentAudience,
  momentKeys,
  momentViews,
  moments,
  users,
  type MomentAttachmentRow,
} from "../db/schema.js";
import { AppError } from "../http/errors.js";
import { toMomentView } from "../http/serializers.js";
import type { MomentContact, MomentDevice, MomentView } from "../types/protocol.js";
import type { MomentBody } from "../http/validation.js";
import type { AttachmentStorage } from "./attachments.js";

export const MOMENT_TTL_SECONDS = 24 * 60 * 60;
export const MAX_MOMENT_AUDIENCE = 50;

export interface CreateMomentInput extends MomentBody {
  authorUserId: string;
  authorDeviceId: string;
}

/** 스토리 생성. 대상 사용자는 내 대화 상대여야 하고, 각자 최소 1개 기기 봉투가 필요하다. */
export async function createMoment(
  db: Database,
  config: Config,
  input: CreateMomentInput,
): Promise<MomentView> {
  const audienceUserIds = [...new Set(input.audienceUserIds)];
  if (audienceUserIds.length === 0) {
    throw AppError.badRequest("AUDIENCE_REQUIRED", "Select at least one audience member");
  }
  if (audienceUserIds.length > MAX_MOMENT_AUDIENCE) {
    throw AppError.badRequest("AUDIENCE_TOO_LARGE", "Too many audience members");
  }
  if (audienceUserIds.includes(input.authorUserId)) {
    throw AppError.badRequest("INVALID_AUDIENCE", "Author cannot be in the audience");
  }

  const { contacts, selfDevices } = await listMomentContacts(db, input.authorUserId);
  const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
  for (const userId of audienceUserIds) {
    if (!contactById.has(userId)) {
      throw AppError.badRequest(
        "INVALID_AUDIENCE",
        "Audience must be someone you share a conversation with",
      );
    }
  }

  const activeDevices = [
    ...selfDevices.map((device) => ({ ...device, userId: input.authorUserId })),
    ...contacts.flatMap((contact) =>
      contact.devices.map((device) => ({ ...device, userId: contact.id })),
    ),
  ];
  const activeDeviceIds = new Set(activeDevices.map((device) => device.id));
  const deviceUserIds = new Map(activeDevices.map((device) => [device.id, device.userId]));
  const allowedRecipientUserIds = new Set([input.authorUserId, ...audienceUserIds]);

  const payload = normalizeMessagePayload(
    {
      clientMessageId: input.id,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      signature: input.signature,
      keys: input.keys,
    },
    {
      maxCiphertextBytes: config.maxCiphertextBytes,
      maxEnvelopes: config.maxEnvelopes,
    },
  );
  if (payload.keys.length === 0) {
    throw AppError.badRequest("INVALID_ENVELOPE", "At least one device envelope is required");
  }
  if (payload.keys.some((key) => key.distribution)) {
    throw AppError.badRequest("INVALID_ENVELOPE", "Sender-key distribution is not supported");
  }
  if (payload.keys.some((key) => !activeDeviceIds.has(key.deviceId))) {
    throw AppError.badRequest(
      "INVALID_ENVELOPE",
      "Envelope targets an unknown or inactive device",
    );
  }
  if (
    payload.keys.some((key) => {
      const deviceUserId = deviceUserIds.get(key.deviceId);
      return !deviceUserId || !allowedRecipientUserIds.has(deviceUserId);
    })
  ) {
    throw AppError.badRequest(
      "INVALID_ENVELOPE",
      "Envelope targets a device outside the selected audience",
    );
  }
  if (!payload.keys.some((key) => key.deviceId === input.authorDeviceId)) {
    throw AppError.badRequest(
      "MISSING_AUTHOR_ENVELOPE",
      "Include an envelope for the author's current device",
    );
  }
  for (const userId of audienceUserIds) {
    if (
      !activeDevices.some(
        (device) => device.userId === userId && payload.keys.some((key) => key.deviceId === device.id),
      )
    ) {
      throw AppError.badRequest(
        "MISSING_AUDIENCE_ENVELOPE",
        "Include at least one envelope per audience member",
      );
    }
  }

  const [authorDevice] = await db
    .select({ signingPublicKey: devices.signingPublicKey })
    .from(devices)
    .where(
      and(
        eq(devices.id, input.authorDeviceId),
        eq(devices.userId, input.authorUserId),
        isNull(devices.revokedAt),
      ),
    )
    .limit(1);
  if (!authorDevice) throw AppError.unauthorized("Unknown author device");

  let attachmentId: string | null = null;
  if (input.attachmentId) {
    const [attachment] = await db
      .select({ id: momentAttachments.id })
      .from(momentAttachments)
      .where(
        and(
          eq(momentAttachments.id, input.attachmentId),
          eq(momentAttachments.uploaderUserId, input.authorUserId),
          eq(momentAttachments.clientMomentId, input.id),
          isNull(momentAttachments.momentId),
        ),
      )
      .limit(1);
    if (!attachment) {
      throw AppError.badRequest("INVALID_ATTACHMENT", "Unknown or already used attachment");
    }
    attachmentId = attachment.id;
  }

  const expiresAt = new Date(Date.now() + MOMENT_TTL_SECONDS * 1000);

  await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(moments)
      .values({
        id: input.id,
        authorUserId: input.authorUserId,
        authorDeviceId: input.authorDeviceId,
        authorSigningPublicKey: authorDevice.signingPublicKey,
        ciphertext: payload.ciphertext,
        nonce: payload.nonce,
        signature: payload.signature,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: moments.id });
    if (!created) {
      throw AppError.conflict("MOMENT_CONFLICT", "Moment already exists");
    }

    await tx.insert(momentAudience).values(
      audienceUserIds.map((userId) => ({ momentId: input.id, userId })),
    );

    await tx.insert(momentKeys).values(
      payload.keys.map((key) => ({
        momentId: input.id,
        recipientDeviceId: key.deviceId,
        ephemeralPublicKey: key.version === 1 ? key.ephemeralPublicKey : null,
        ratchetPublicKey: key.version === 2 ? key.ratchetPublicKey : null,
        previousChainLength: key.version === 2 ? key.previousChainLength : null,
        messageNumber: key.version === 2 ? key.messageNumber : null,
        senderIdentityPublicKey:
          key.version === 2 ? (key.senderIdentityPublicKey ?? null) : null,
        signedPreKeyId: key.version === 2 ? (key.signedPreKeyId ?? null) : null,
        oneTimePreKeyId: key.version === 2 ? (key.oneTimePreKeyId ?? null) : null,
        wrappedKey: key.wrappedKey,
        wrapNonce: key.wrapNonce,
        version: key.version,
      })),
    );

    // v2 봉투에 사용한 원타임 프리키는 메시지와 동일하게 1회 소비한다.
    for (const key of payload.keys) {
      if (key.version !== 2 || !key.oneTimePreKeyId) continue;
      const [preKey] = await tx
        .select({
          keyId: deviceOneTimePreKeys.keyId,
          usedAt: deviceOneTimePreKeys.usedAt,
        })
        .from(deviceOneTimePreKeys)
        .where(
          and(
            eq(deviceOneTimePreKeys.deviceId, key.deviceId),
            eq(deviceOneTimePreKeys.keyId, key.oneTimePreKeyId),
          ),
        )
        .limit(1);
      if (!preKey) {
        throw AppError.conflict(
          "PREKEY_CONSUMED",
          "Unknown one-time prekey; refresh the device bundle",
        );
      }
      if (!preKey.usedAt) {
        await tx
          .update(deviceOneTimePreKeys)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(deviceOneTimePreKeys.deviceId, key.deviceId),
              eq(deviceOneTimePreKeys.keyId, key.oneTimePreKeyId),
              isNull(deviceOneTimePreKeys.usedAt),
            ),
          );
      }
    }

    if (attachmentId) {
      await tx
        .update(momentAttachments)
        .set({ momentId: input.id })
        .where(eq(momentAttachments.id, attachmentId));
    }
  });

  return getMomentForUser(db, {
    momentId: input.id,
    userId: input.authorUserId,
    deviceId: input.authorDeviceId,
  });
}

export async function getMomentForUser(
  db: Database,
  input: { momentId: string; userId: string; deviceId: string },
): Promise<MomentView> {
  const [row] = await db
    .select({ moment: moments, author: users })
    .from(moments)
    .innerJoin(users, eq(users.id, moments.authorUserId))
    .where(and(eq(moments.id, input.momentId), gt(moments.expiresAt, new Date())))
    .limit(1);
  if (!row) {
    throw AppError.notFound("MOMENT_NOT_FOUND", "Moment not found or expired");
  }

  const isAuthor = row.moment.authorUserId === input.userId;
  if (!isAuthor) {
    const [audience] = await db
      .select({ userId: momentAudience.userId })
      .from(momentAudience)
      .where(
        and(
          eq(momentAudience.momentId, input.momentId),
          eq(momentAudience.userId, input.userId),
        ),
      )
      .limit(1);
    if (!audience) {
      throw AppError.notFound("MOMENT_NOT_FOUND", "Moment not found or expired");
    }
  }

  const [key] = await db
    .select()
    .from(momentKeys)
    .where(
      and(
        eq(momentKeys.momentId, input.momentId),
        eq(momentKeys.recipientDeviceId, input.deviceId),
      ),
    )
    .limit(1);

  const extras: { viewCount?: number; viewed?: boolean } = {};
  if (isAuthor) {
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(momentViews)
      .where(eq(momentViews.momentId, input.momentId));
    extras.viewCount = count?.count ?? 0;
  } else {
    const [view] = await db
      .select({ momentId: momentViews.momentId })
      .from(momentViews)
      .where(
        and(
          eq(momentViews.momentId, input.momentId),
          eq(momentViews.viewerUserId, input.userId),
        ),
      )
      .limit(1);
    extras.viewed = Boolean(view);
  }

  return toMomentView(row.moment, row.author, key ?? null, extras);
}

/** 내가 작성했거나 공개 대상인, 만료되지 않은 스토리 목록. */
export async function listMomentFeed(
  db: Database,
  input: { userId: string; deviceId: string },
): Promise<MomentView[]> {
  const now = new Date();
  const rows = await db
    .select({ moment: moments, author: users })
    .from(moments)
    .innerJoin(users, eq(users.id, moments.authorUserId))
    .where(
      and(
        gt(moments.expiresAt, now),
        or(
          eq(moments.authorUserId, input.userId),
          sql`exists (
            select 1 from ${momentAudience}
            where ${momentAudience.momentId} = ${moments.id}
              and ${momentAudience.userId} = ${input.userId}
          )`,
        ),
      ),
    )
    .orderBy(desc(moments.createdAt))
    .limit(100);

  if (rows.length === 0) return [];
  const momentIds = rows.map((row) => row.moment.id);

  const [keys, viewCounts, viewedRows] = await Promise.all([
    db
      .select()
      .from(momentKeys)
      .where(
        and(
          inArray(momentKeys.momentId, momentIds),
          eq(momentKeys.recipientDeviceId, input.deviceId),
        ),
      ),
    db
      .select({
        momentId: momentViews.momentId,
        count: sql<number>`count(*)::int`,
      })
      .from(momentViews)
      .where(inArray(momentViews.momentId, momentIds))
      .groupBy(momentViews.momentId),
    db
      .select({ momentId: momentViews.momentId })
      .from(momentViews)
      .where(
        and(
          inArray(momentViews.momentId, momentIds),
          eq(momentViews.viewerUserId, input.userId),
        ),
      ),
  ]);

  const keyByMoment = new Map(keys.map((key) => [key.momentId, key]));
  const countByMoment = new Map(viewCounts.map((row) => [row.momentId, row.count]));
  const viewed = new Set(viewedRows.map((row) => row.momentId));

  return rows.map((row) => {
    const isAuthor = row.moment.authorUserId === input.userId;
    return toMomentView(row.moment, row.author, keyByMoment.get(row.moment.id) ?? null, {
      ...(isAuthor
        ? { viewCount: countByMoment.get(row.moment.id) ?? 0 }
        : { viewed: viewed.has(row.moment.id) }),
    });
  });
}

/** 조회 기록. 작성자 본인의 조회는 기록하지 않는다. */
export async function markMomentViewed(
  db: Database,
  input: { momentId: string; userId: string },
): Promise<void> {
  const [moment] = await db
    .select({ authorUserId: moments.authorUserId })
    .from(moments)
    .where(and(eq(moments.id, input.momentId), gt(moments.expiresAt, new Date())))
    .limit(1);
  if (!moment) {
    throw AppError.notFound("MOMENT_NOT_FOUND", "Moment not found or expired");
  }
  if (moment.authorUserId === input.userId) return;

  const [audience] = await db
    .select({ userId: momentAudience.userId })
    .from(momentAudience)
    .where(
      and(
        eq(momentAudience.momentId, input.momentId),
        eq(momentAudience.userId, input.userId),
      ),
    )
    .limit(1);
  if (!audience) {
    throw AppError.notFound("MOMENT_NOT_FOUND", "Moment not found or expired");
  }

  await db
    .insert(momentViews)
    .values({ momentId: input.momentId, viewerUserId: input.userId })
    .onConflictDoNothing();
}

export async function listMomentViews(
  db: Database,
  input: { momentId: string; userId: string },
): Promise<Array<{ userId: string; username: string; viewedAt: Date }>> {
  const [moment] = await db
    .select({ authorUserId: moments.authorUserId })
    .from(moments)
    .where(eq(moments.id, input.momentId))
    .limit(1);
  if (!moment) throw AppError.notFound("MOMENT_NOT_FOUND", "Moment not found");
  if (moment.authorUserId !== input.userId) {
    throw AppError.forbidden("Only the author can see viewers");
  }

  return db
    .select({
      userId: momentViews.viewerUserId,
      username: users.username,
      viewedAt: momentViews.viewedAt,
    })
    .from(momentViews)
    .innerJoin(users, eq(users.id, momentViews.viewerUserId))
    .where(eq(momentViews.momentId, input.momentId))
    .orderBy(desc(momentViews.viewedAt));
}

/** 작성자만 삭제할 수 있다. 첨부 블롭도 함께 삭제한다. */
export async function deleteMoment(
  db: Database,
  storage: AttachmentStorage,
  input: { momentId: string; userId: string },
): Promise<void> {
  const [moment] = await db
    .select({ authorUserId: moments.authorUserId })
    .from(moments)
    .where(eq(moments.id, input.momentId))
    .limit(1);
  if (!moment) throw AppError.notFound("MOMENT_NOT_FOUND", "Moment not found");
  if (moment.authorUserId !== input.userId) {
    throw AppError.forbidden("Only the author can delete this moment");
  }

  const attachments = await db
    .select({ id: momentAttachments.id })
    .from(momentAttachments)
    .where(eq(momentAttachments.momentId, input.momentId));
  for (const attachment of attachments) {
    await storage.delete(attachment.id).catch(() => undefined);
  }
  await db.delete(moments).where(eq(moments.id, input.momentId));
}

export async function createMomentAttachment(
  db: Database,
  storage: AttachmentStorage,
  input: { uploaderUserId: string; clientMomentId: string | null; data: Buffer },
): Promise<MomentAttachmentRow> {
  const id = randomUUID();
  await storage.put(id, input.data);
  try {
    const [row] = await db
      .insert(momentAttachments)
      .values({
        id,
        uploaderUserId: input.uploaderUserId,
        clientMomentId: input.clientMomentId,
        size: input.data.byteLength,
      })
      .returning();
    if (!row) throw new Error("Failed to insert moment attachment");
    return row;
  } catch (error) {
    await storage.delete(id);
    throw error;
  }
}

export async function markMomentAttachmentAccessed(
  db: Database,
  attachmentId: string,
): Promise<void> {
  await db
    .update(momentAttachments)
    .set({ lastAccessedAt: new Date() })
    .where(eq(momentAttachments.id, attachmentId));
}

/** 계정 삭제 전에 사용자가 올린 모먼트 이미지 블롭을 정리하기 위해 ID를 모은다. */
export async function listUserMomentAttachmentIds(
  db: Database,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: momentAttachments.id })
    .from(momentAttachments)
    .where(eq(momentAttachments.uploaderUserId, userId));
  return rows.map((row) => row.id);
}

/** 계정 삭제 시 작성한 모먼트 행을 정리한다(대상·봉투·조회·첨부 행 cascade). */
export async function deleteUserMoments(db: Database, userId: string): Promise<void> {
  await db.delete(moments).where(eq(moments.authorUserId, userId));
}

/** 업로더(연결 전) 또는 스토리 작성자/공개 대상만 첨부 암호문을 받을 수 있다. */
export async function requireMomentAttachmentAccess(
  db: Database,
  input: { attachmentId: string; userId: string },
): Promise<MomentAttachmentRow> {
  const [row] = await db
    .select({ attachment: momentAttachments, moment: moments })
    .from(momentAttachments)
    .leftJoin(moments, eq(moments.id, momentAttachments.momentId))
    .where(eq(momentAttachments.id, input.attachmentId))
    .limit(1);
  if (!row) {
    throw AppError.notFound("ATTACHMENT_NOT_FOUND", "Attachment not found");
  }
  if (!row.attachment.momentId) {
    if (row.attachment.uploaderUserId !== input.userId) {
      throw AppError.notFound("ATTACHMENT_NOT_FOUND", "Attachment not found");
    }
    return row.attachment;
  }
  if (!row.moment || row.moment.expiresAt.getTime() <= Date.now()) {
    throw AppError.notFound("ATTACHMENT_NOT_FOUND", "Attachment not found");
  }
  if (row.moment.authorUserId !== input.userId) {
    const [audience] = await db
      .select({ userId: momentAudience.userId })
      .from(momentAudience)
      .where(
        and(
          eq(momentAudience.momentId, row.attachment.momentId),
          eq(momentAudience.userId, input.userId),
        ),
      )
      .limit(1);
    if (!audience) {
      throw AppError.notFound("ATTACHMENT_NOT_FOUND", "Attachment not found");
    }
  }
  return row.attachment;
}

export interface CleanupMomentsResult {
  moments: number;
  attachments: number;
}

/** 만료된 스토리와 연결되지 않은 오래된 업로드를 삭제한다. */
export async function cleanupExpiredMoments(
  db: Database,
  storage: AttachmentStorage,
  options: { now?: Date; orphanBefore?: Date } = {},
): Promise<CleanupMomentsResult> {
  const now = options.now ?? new Date();
  const expired = await db
    .select({ id: moments.id })
    .from(moments)
    .where(lt(moments.expiresAt, now));

  let attachments = 0;
  for (const moment of expired) {
    const rows = await db
      .select({ id: momentAttachments.id })
      .from(momentAttachments)
      .where(eq(momentAttachments.momentId, moment.id));
    for (const row of rows) {
      await storage.delete(row.id).catch(() => undefined);
      attachments += 1;
    }
  }
  if (expired.length > 0) {
    await db.delete(moments).where(
      inArray(
        moments.id,
        expired.map((moment) => moment.id),
      ),
    );
  }

  if (options.orphanBefore) {
    const orphans = await db
      .select({ id: momentAttachments.id })
      .from(momentAttachments)
      .where(
        and(
          isNull(momentAttachments.momentId),
          lt(momentAttachments.createdAt, options.orphanBefore),
        ),
      );
    for (const row of orphans) {
      await storage.delete(row.id).catch(() => undefined);
      await db.delete(momentAttachments).where(eq(momentAttachments.id, row.id));
      attachments += 1;
    }
  }

  return { moments: expired.length, attachments };
}

interface ActiveDeviceKey extends MomentDevice {
  userId: string;
}

async function listActiveDevicesForUsers(
  db: Database,
  userIds: string[],
): Promise<ActiveDeviceKey[]> {
  if (userIds.length === 0) return [];
  const activeDevices = await db
    .select({
      id: devices.id,
      userId: devices.userId,
      identityPublicKey: devices.identityPublicKey,
      signingPublicKey: devices.signingPublicKey,
      signedPreKeyId: devices.signedPreKeyId,
      signedPreKeyPublicKey: devices.signedPreKeyPublicKey,
      signedPreKeySignature: devices.signedPreKeySignature,
    })
    .from(devices)
    .where(and(inArray(devices.userId, userIds), isNull(devices.revokedAt)))
    .orderBy(devices.createdAt, devices.id);
  if (activeDevices.length === 0) return [];

  const preKeys = await db
    .select({
      deviceId: deviceOneTimePreKeys.deviceId,
      keyId: deviceOneTimePreKeys.keyId,
      publicKey: deviceOneTimePreKeys.publicKey,
    })
    .from(deviceOneTimePreKeys)
    .where(
      and(
        inArray(
          deviceOneTimePreKeys.deviceId,
          activeDevices.map((device) => device.id),
        ),
        isNull(deviceOneTimePreKeys.usedAt),
      ),
    )
    .orderBy(deviceOneTimePreKeys.createdAt, deviceOneTimePreKeys.keyId);

  const firstPreKey = new Map<string, { keyId: string; publicKey: string }>();
  for (const preKey of preKeys) {
    if (!firstPreKey.has(preKey.deviceId)) firstPreKey.set(preKey.deviceId, preKey);
  }

  return activeDevices.map((device) => {
    const preKey = firstPreKey.get(device.id);
    return {
      ...device,
      oneTimePreKeyId: preKey?.keyId ?? null,
      oneTimePreKeyPublicKey: preKey?.publicKey ?? null,
    };
  });
}

/** 내가 참여한 대화의 상대 사용자 + 각자의 활성 기기(공개키/프리키). */
export async function listMomentContacts(
  db: Database,
  userId: string,
): Promise<{ contacts: MomentContact[]; selfDevices: MomentDevice[] }> {
  const conversationRows = await db
    .select({ conversationId: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.userId, userId));
  const conversationIds = conversationRows.map((row) => row.conversationId);

  const contactRows = conversationIds.length
    ? await db
        .selectDistinct({
          id: users.id,
          username: users.username,
          deletedAt: users.deletedAt,
        })
        .from(conversationParticipants)
        .innerJoin(users, eq(users.id, conversationParticipants.userId))
        .where(
          and(
            inArray(conversationParticipants.conversationId, conversationIds),
            ne(conversationParticipants.userId, userId),
            isNull(users.deletedAt),
          ),
        )
        .limit(100)
    : [];

  const allDevices = await listActiveDevicesForUsers(db, [
    userId,
    ...contactRows.map((row) => row.id),
  ]);
  const devicesByUser = new Map<string, MomentDevice[]>();
  for (const device of allDevices) {
    const { userId: deviceUserId, ...publicDevice } = device;
    const list = devicesByUser.get(deviceUserId) ?? [];
    list.push(publicDevice);
    devicesByUser.set(deviceUserId, list);
  }

  return {
    contacts: contactRows.map((row) => ({
      id: row.id,
      username: row.username,
      devices: devicesByUser.get(row.id) ?? [],
    })),
    selfDevices: devicesByUser.get(userId) ?? [],
  };
}
