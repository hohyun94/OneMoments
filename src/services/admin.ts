import { and, desc, eq, gt, ilike, sql } from "drizzle-orm";

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
