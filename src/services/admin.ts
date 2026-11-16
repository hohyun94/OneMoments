import { and, desc, eq, gt, ilike, isNotNull, isNull, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  adminAuditLogs,
  attachments,
  conversationParticipants,
  conversations,
  devices,
  loginProfiles,
  messages,
  pushSubscriptions,
  sessions,
  users,
} from "../db/schema.js";
import { AppError } from "../http/errors.js";
import { toPublicUser } from "../http/serializers.js";
import type { PublicUser } from "../types/protocol.js";

/**
 * 관리자 콘솔 서비스.
 * 서버는 여전히 평문·키·세션 토큰을 모르며, 이 모듈도 메타데이터만 다룬다.
 */

export interface AdminOverview {
  usersTotal: number;
  usersDeleted: number;
  devicesActive: number;
  devicesRevoked: number;
  directConversations: number;
  groupConversations: number;
  messages: number;
  attachments: number;
  attachmentBytes: number;
  activeSessions: number;
  pushSubscriptions: number;
  decoyProfiles: number;
  decoyProfilesDisabled: number;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function getAdminOverview(db: Database): Promise<AdminOverview> {
  const [
    userCounts,
    deviceCounts,
    conversationCounts,
    messageCounts,
    attachmentCounts,
    sessionCounts,
    pushCounts,
    decoyCounts,
  ] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        deleted: sql<number>`count(${users.deletedAt})::int`,
      })
      .from(users),
    db
      .select({
        active: sql<number>`(count(*) filter (where ${devices.revokedAt} is null))::int`,
        revoked: sql<number>`(count(*) filter (where ${devices.revokedAt} is not null))::int`,
      })
      .from(devices),
    db
      .select({
        direct: sql<number>`(count(*) filter (where ${conversations.kind} = 'direct'))::int`,
        group: sql<number>`(count(*) filter (where ${conversations.kind} = 'group'))::int`,
      })
      .from(conversations),
    db.select({ total: sql<number>`count(*)::int` }).from(messages),
    db
      .select({
        total: sql<number>`count(*)::int`,
        bytes: sql<string>`coalesce(sum(${attachments.size}), 0)::bigint`,
      })
      .from(attachments),
    db
      .select({
        active: sql<number>`(count(*) filter (where ${sessions.expiresAt} > now()))::int`,
      })
      .from(sessions),
    db.select({ total: sql<number>`count(*)::int` }).from(pushSubscriptions),
    db
      .select({
        total: sql<number>`count(*)::int`,
        disabled: sql<number>`(count(*) filter (where ${loginProfiles.disabledAt} is not null))::int`,
      })
      .from(loginProfiles),
  ]);

  return {
    usersTotal: userCounts[0]?.total ?? 0,
    usersDeleted: userCounts[0]?.deleted ?? 0,
    devicesActive: deviceCounts[0]?.active ?? 0,
    devicesRevoked: deviceCounts[0]?.revoked ?? 0,
    directConversations: conversationCounts[0]?.direct ?? 0,
    groupConversations: conversationCounts[0]?.group ?? 0,
    messages: messageCounts[0]?.total ?? 0,
    attachments: attachmentCounts[0]?.total ?? 0,
    attachmentBytes: Number(attachmentCounts[0]?.bytes ?? 0),
    activeSessions: sessionCounts[0]?.active ?? 0,
    pushSubscriptions: pushCounts[0]?.total ?? 0,
    decoyProfiles: decoyCounts[0]?.total ?? 0,
    decoyProfilesDisabled: decoyCounts[0]?.disabled ?? 0,
  };
}

/** LIKE 메타문자를 사용자 입력으로 해석하지 않게 한다. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface AdminUserListItem {
  id: string;
  username: string;
  createdAt: string;
  deleted: boolean;
  activeDeviceCount: number;
  activeSessionCount: number;
}

export interface AdminUserPage {
  users: AdminUserListItem[];
  nextCursor: string | null;
}

/** username 부분 일치(대소문자 무시) + username 키셋 페이지네이션. */
export async function listAdminUsers(
  db: Database,
  input: { query?: string; cursor?: string; limit: number },
): Promise<AdminUserPage> {
  const conditions = [];
  if (input.query) {
    conditions.push(ilike(users.username, `%${escapeLikePattern(input.query.toLowerCase())}%`));
  }
  if (input.cursor) {
    conditions.push(gt(users.username, input.cursor.toLowerCase()));
  }

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      createdAt: users.createdAt,
      deletedAt: users.deletedAt,
      activeDeviceCount:
        sql<number>`(select count(*)::int from devices d where d.user_id = users.id and d.revoked_at is null)`,
      activeSessionCount:
        sql<number>`(select count(*)::int from sessions s where s.user_id = users.id and s.expires_at > now())`,
    })
    .from(users)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(users.username)
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  return {
    users: page.map((row) => ({
      id: row.id,
      username: row.username,
      createdAt: row.createdAt.toISOString(),
      deleted: row.deletedAt !== null,
      activeDeviceCount: row.activeDeviceCount,
      activeSessionCount: row.activeSessionCount,
    })),
    nextCursor: rows.length > input.limit ? (page.at(-1)?.username ?? null) : null,
  };
}

export interface AdminDeviceListItem {
  id: string;
  userId: string;
  username: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface AdminDevicePage {
  devices: AdminDeviceListItem[];
  nextCursor: string | null;
}

/**
 * 관리자 기기 목록. 소유자 username·기기 이름·활성/폐기 상태만 노출하며
 * 공개키·키 봉투·세션 토큰은 반환하지 않는다.
 * 정렬은 최근 등록순이고 커서는 `<createdAt ISO>|<deviceId>` 이다.
 */
export async function listAdminDevices(
  db: Database,
  input: {
    query?: string;
    status: "active" | "revoked" | "all";
    cursor?: string;
    limit: number;
  },
): Promise<AdminDevicePage> {
  const conditions = [];
  if (input.status === "active") conditions.push(isNull(devices.revokedAt));
  if (input.status === "revoked") conditions.push(isNotNull(devices.revokedAt));
  if (input.query) {
    conditions.push(ilike(users.username, `%${escapeLikePattern(input.query.toLowerCase())}%`));
  }
  if (input.cursor) {
    const [createdAtRaw, deviceId] = input.cursor.split("|");
    const createdAt = new Date(createdAtRaw ?? "");
    if (!deviceId || Number.isNaN(createdAt.getTime())) {
      throw AppError.badRequest("INVALID_CURSOR", "Invalid device cursor");
    }
    conditions.push(sql`(${devices.createdAt}, ${devices.id}) < (${createdAt}, ${deviceId})`);
  }

  const rows = await db
    .select({
      id: devices.id,
      userId: devices.userId,
      username: users.username,
      name: devices.name,
      createdAt: devices.createdAt,
      lastSeenAt: devices.lastSeenAt,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(devices.createdAt), desc(devices.id))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    devices: page.map((row) => ({
      id: row.id,
      userId: row.userId,
      username: row.username,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: iso(row.lastSeenAt),
      revokedAt: iso(row.revokedAt),
    })),
    nextCursor:
      rows.length > input.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
  };
}

export interface AdminDeviceRevokeResult {
  device: AdminDeviceListItem;
  /** 이미 폐기된 기기면 false (감사 로그도 추가하지 않는다). */
  revoked: boolean;
}

/**
 * 관리자에 의한 기기 폐기.
 * 사용자용 폐기와 동일하게 세션·푸시 구독을 함께 삭제하고(불변식 18),
 * 감사 로그에는 기기 이름 같은 메타데이터만 남긴다(키·토큰 금지).
 */
export async function revokeAdminDevice(
  db: Database,
  input: { adminUserId: string; adminUsername: string; deviceId: string },
): Promise<AdminDeviceRevokeResult> {
  const [target] = await db
    .select({
      id: devices.id,
      userId: devices.userId,
      username: users.username,
      name: devices.name,
      createdAt: devices.createdAt,
      lastSeenAt: devices.lastSeenAt,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(eq(devices.id, input.deviceId))
    .limit(1);
  if (!target) throw AppError.notFound("DEVICE_NOT_FOUND", "Device not found");

  if (target.revokedAt) {
    return {
      device: {
        id: target.id,
        userId: target.userId,
        username: target.username,
        name: target.name,
        createdAt: target.createdAt.toISOString(),
        lastSeenAt: iso(target.lastSeenAt),
        revokedAt: iso(target.revokedAt),
      },
      revoked: false,
    };
  }

  const revokedAt = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(and(eq(devices.id, input.deviceId), isNull(devices.revokedAt)))
      .returning({ revokedAt: devices.revokedAt });
    if (!row) throw AppError.notFound("DEVICE_NOT_FOUND", "Device not found");
    await tx.delete(sessions).where(eq(sessions.deviceId, input.deviceId));
    await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.deviceId, input.deviceId));
    await recordAdminAudit(tx, {
      adminUserId: input.adminUserId,
      adminUsername: input.adminUsername,
      action: "device.revoked",
      targetUserId: target.userId,
      targetUsername: target.username,
      detail: { deviceName: target.name },
    });
    return row.revokedAt;
  });

  return {
    device: {
      id: target.id,
      userId: target.userId,
      username: target.username,
      name: target.name,
      createdAt: target.createdAt.toISOString(),
      lastSeenAt: iso(target.lastSeenAt),
      revokedAt: iso(revokedAt),
    },
    revoked: true,
  };
}

export interface AdminDeviceItem {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface AdminSessionItem {
  id: string;
  deviceId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
}

export interface AdminUserDetail {
  user: PublicUser;
  devices: AdminDeviceItem[];
  sessions: AdminSessionItem[];
  counts: {
    conversations: number;
    messages: number;
    attachments: number;
    pushSubscriptions: number;
  };
  decoy: { id: string; alias: string; disabledAt: string | null } | null;
}

export async function getAdminUserDetail(
  db: Database,
  userId: string,
): Promise<AdminUserDetail> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw AppError.notFound("USER_NOT_FOUND", "User not found");

  const [
    deviceRows,
    sessionRows,
    conversationCount,
    messageCount,
    attachmentCount,
    pushCount,
    decoyRows,
  ] = await Promise.all([
    db
      .select({
        id: devices.id,
        name: devices.name,
        createdAt: devices.createdAt,
        lastSeenAt: devices.lastSeenAt,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .where(eq(devices.userId, userId))
      .orderBy(desc(devices.createdAt)),
    // token_hash 는 절대 내보내지 않는다.
    db
      .select({
        id: sessions.id,
        deviceId: sessions.deviceId,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.createdAt)),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.userId, userId)),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.senderUserId, userId)),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(attachments)
      .where(eq(attachments.uploaderUserId, userId)),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId)),
    db
      .select({
        id: loginProfiles.id,
        alias: loginProfiles.alias,
        disabledAt: loginProfiles.disabledAt,
      })
      .from(loginProfiles)
      .where(eq(loginProfiles.userId, userId))
      .limit(1),
  ]);

  return {
    user: toPublicUser(user),
    devices: deviceRows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: iso(row.lastSeenAt),
      revokedAt: iso(row.revokedAt),
    })),
    sessions: sessionRows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      userAgent: row.userAgent,
    })),
    counts: {
      conversations: conversationCount[0]?.total ?? 0,
      messages: messageCount[0]?.total ?? 0,
      attachments: attachmentCount[0]?.total ?? 0,
      pushSubscriptions: pushCount[0]?.total ?? 0,
    },
    decoy: decoyRows[0]
      ? {
          id: decoyRows[0].id,
          alias: decoyRows[0].alias,
          disabledAt: iso(decoyRows[0].disabledAt),
        }
      : null,
  };
}

/** 감사 로그 작성. DB 또는 트랜잭션 핸들 모두 받는다. */
export interface AuditWriter {
  insert(table: typeof adminAuditLogs): {
    values(value: typeof adminAuditLogs.$inferInsert): Promise<unknown>;
  };
}

export async function recordAdminAudit(
  writer: AuditWriter,
  input: {
    adminUserId: string;
    adminUsername: string;
    action: string;
    targetUserId?: string | null;
    targetUsername?: string | null;
    detail?: Record<string, unknown> | null;
  },
): Promise<void> {
  await writer.insert(adminAuditLogs).values({
    adminUserId: input.adminUserId,
    adminUsername: input.adminUsername,
    action: input.action,
    targetUserId: input.targetUserId ?? null,
    targetUsername: input.targetUsername ?? null,
    detail: input.detail ?? null,
  });
}

/** 관리자에 의한 세션 강제 종료 + 푸시 구독 정리(불변식 18). */
export async function revokeUserSessions(
  db: Database,
  input: {
    adminUserId: string;
    adminUsername: string;
    targetUserId: string;
  },
): Promise<{ revokedSessions: number }> {
  const [target] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.id, input.targetUserId))
    .limit(1);
  if (!target) throw AppError.notFound("USER_NOT_FOUND", "User not found");

  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(sessions)
      .where(eq(sessions.userId, target.id))
      .returning({ id: sessions.id });
    await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, target.id));
    await recordAdminAudit(tx, {
      adminUserId: input.adminUserId,
      adminUsername: input.adminUsername,
      action: "user.sessions.revoked",
      targetUserId: target.id,
      targetUsername: target.username,
      detail: { revokedSessions: deleted.length },
    });
    return { revokedSessions: deleted.length };
  });
}

export interface AdminAuditItem {
  id: string;
  adminUsername: string;
  action: string;
  targetUsername: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export async function listAdminAudit(db: Database, limit = 100): Promise<AdminAuditItem[]> {
  const rows = await db
    .select({
      id: adminAuditLogs.id,
      adminUsername: adminAuditLogs.adminUsername,
      action: adminAuditLogs.action,
      targetUsername: adminAuditLogs.targetUsername,
      detail: adminAuditLogs.detail,
      createdAt: adminAuditLogs.createdAt,
    })
    .from(adminAuditLogs)
    .orderBy(desc(adminAuditLogs.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    adminUsername: row.adminUsername,
    action: row.action,
    targetUsername: row.targetUsername,
    detail: row.detail ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}
