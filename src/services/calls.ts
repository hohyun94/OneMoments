import { desc, eq, sql } from "drizzle-orm";

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
