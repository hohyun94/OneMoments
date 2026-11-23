import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { callLogs } from "../db/schema.js";

export type CallLogStatus =
  | "ringing"
  | "completed"
  | "missed"
  | "declined"
  | "cancelled"
  | "failed";

export interface CallLogView {
  id: string;
  callId: string;
  status: CallLogStatus;
  /** 조회하는 사용자 기준 방향 */
  direction: "outgoing" | "incoming";
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
}

/** 발신 시작 시 통화 기록을 만든다(같은 callId 재전송은 무시). */
export async function startCallLog(
  db: Database,
  input: {
    callId: string;
    conversationId: string;
    callerUserId: string;
    calleeUserId: string;
  },
): Promise<void> {
  await db
    .insert(callLogs)
    .values({
      callId: input.callId,
      conversationId: input.conversationId,
      callerUserId: input.callerUserId,
      calleeUserId: input.calleeUserId,
      status: "ringing",
    })
    .onConflictDoNothing({ target: callLogs.callId });
}

/** 수락 시각만 기록한다(최종 상태·길이는 종료 시 계산). */
export async function markCallAnswered(
  db: Database,
  input: { callId: string },
): Promise<void> {
  await db
    .update(callLogs)
    .set({ answeredAt: sql`now()` })
    .where(eq(callLogs.callId, input.callId));
}

/**
 * 종료 계열 이벤트로 최종 상태와 길이를 확정한다.
 *
 * - decline → declined
 * - cancel  → 응답 전이면 missed, 응답 후면 completed
 * - end     → 실패 사유면 failed, 응답 전이면 missed, 그 외 completed
 */
export async function finishCallLog(
  db: Database,
  input: {
    callId: string;
    event: "decline" | "cancel" | "end";
    userId: string;
    reason?: string;
  },
): Promise<void> {
  const statusExpression =
    input.event === "decline"
      ? sql`'declined'`
      : input.event === "end" && input.reason === "failed"
        ? sql`'failed'`
        : sql`case when ${callLogs.answeredAt} is null then 'missed' else 'completed' end`;

  await db
    .update(callLogs)
    .set({
      status: statusExpression,
      endedAt: sql`now()`,
      endedByUserId: input.userId,
      durationSeconds: sql`case when ${callLogs.answeredAt} is null then null else greatest(0, floor(extract(epoch from (now() - ${callLogs.answeredAt}))))::int end`,
    })
    .where(eq(callLogs.callId, input.callId));
}

/** 대화의 최근 통화 기록(최신순). */
export async function listCallLogs(
  db: Database,
  input: { conversationId: string; userId: string; limit?: number },
): Promise<CallLogView[]> {
  const rows = await db
    .select()
    .from(callLogs)
    .where(eq(callLogs.conversationId, input.conversationId))
    .orderBy(desc(callLogs.startedAt))
    .limit(input.limit ?? 50);
  return rows.map((row) => ({
    id: row.id,
    callId: row.callId,
    status: row.status as CallLogStatus,
    direction: row.callerUserId === input.userId ? "outgoing" : "incoming",
    startedAt: row.startedAt.toISOString(),
    answeredAt: row.answeredAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    durationSeconds: row.durationSeconds,
  }));
}

/**
 * 수신자가 부재중 기록을 확인했음을 표시한다(대화 목록 배지 해제).
 * 부재중 상태이면서 아직 확인하지 않은 행만 갱신하고, 갱신 건수를 돌려준다.
 */
export async function markMissedCallsSeen(
  db: Database,
  input: { conversationId: string; userId: string },
): Promise<number> {
  const updated = await db
    .update(callLogs)
    .set({ calleeSeenAt: sql`now()` })
    .where(
      and(
        eq(callLogs.conversationId, input.conversationId),
        eq(callLogs.calleeUserId, input.userId),
        eq(callLogs.status, "missed"),
        isNull(callLogs.calleeSeenAt),
      ),
    )
    .returning({ id: callLogs.id });
  return updated.length;
}

/** 대화 목록 배지용: 사용자가 아직 확인하지 않은 부재중 통화 수(대화별). */
export async function countMissedCallsByConversation(
  db: Database,
  input: { conversationIds: string[]; userId: string },
): Promise<Map<string, number>> {
  if (input.conversationIds.length === 0) return new Map();
  const rows = await db
    .select({
      conversationId: callLogs.conversationId,
      count: sql<number>`count(*)::int`,
    })
    .from(callLogs)
    .where(
      and(
        inArray(callLogs.conversationId, input.conversationIds),
        eq(callLogs.calleeUserId, input.userId),
        eq(callLogs.status, "missed"),
        isNull(callLogs.calleeSeenAt),
      ),
    )
    .groupBy(callLogs.conversationId);
  return new Map(rows.map((row) => [row.conversationId, row.count]));
}
