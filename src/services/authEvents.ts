import { and, desc, eq, lt } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { authEvents } from "../db/schema.js";

/** 관리자 콘솔에서 구분해 보여주는 인증 이벤트 종류. */
export type AuthEventType =
  | "register"
  | "login"
  | "logout"
  | "device_logout"
  | "device_revoked"
  | "recover"
  | "admin_sessions_revoked";

export interface AuthEventInput {
  userId: string;
  deviceId?: string | null;
  event: AuthEventType;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * 인증 이벤트를 append-only 로 기록한다(무기한 보존).
 * 기록 실패가 로그인·로그아웃 자체를 막지 않도록 예외를 삼키되,
 * IP·user-agent 원문 없이 이벤트 이름만 서버 로그에 남긴다.
 */
export async function recordAuthEvent(
  db: Database,
  input: AuthEventInput,
): Promise<void> {
  try {
    await db.insert(authEvents).values({
      userId: input.userId,
      deviceId: input.deviceId ?? null,
      event: input.event,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
  } catch {
    console.error(
      JSON.stringify({
        level: "error",
        event: "auth_event_insert_failed",
        kind: input.event,
      }),
    );
  }
}

export interface AdminAuthEvent {
  id: string;
  event: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface AdminAuthEventPage {
  events: AdminAuthEvent[];
  nextCursor: string | null;
}

/** 관리자 전용: 사용자별 인증 이벤트를 최신순으로 조회한다. */
export async function listAuthEvents(
  db: Database,
  input: { userId: string; before?: string | undefined; limit: number },
): Promise<AdminAuthEventPage> {
  const conditions = [eq(authEvents.userId, input.userId)];
  if (input.before) {
    const before = new Date(input.before);
    if (!Number.isNaN(before.getTime())) {
      conditions.push(lt(authEvents.createdAt, before));
    }
  }

  const rows = await db
    .select()
    .from(authEvents)
    .where(and(...conditions))
    .orderBy(desc(authEvents.createdAt))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const hasMore = rows.length > input.limit;
  return {
    events: page.map((row) => ({
      id: row.id,
      event: row.event,
      deviceId: row.deviceId,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? (page.at(-1)?.createdAt.toISOString() ?? null) : null,
  };
}
