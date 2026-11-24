import { and, eq, inArray, isNull, ne } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import {
  devices,
  pushSubscriptions,
  type MessageRow,
  type PushSubscriptionRow,
} from "../db/schema.js";
import { createVapidKeys } from "../push/vapid.js";
import { sendWebPush } from "../push/webPush.js";

export interface UpsertPushSubscriptionInput {
  userId: string;
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function upsertPushSubscription(
  db: Database,
  input: UpsertPushSubscriptionInput,
): Promise<PushSubscriptionRow> {
  const [row] = await db
    .insert(pushSubscriptions)
    .values(input)
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: input.userId,
        deviceId: input.deviceId,
        p256dh: input.p256dh,
        auth: input.auth,
        failureCount: 0,
      },
    })
    .returning();
  if (!row) throw new Error("Failed to store push subscription");
  return row;
}

export async function removePushSubscription(
  db: Database,
  input: { userId: string; deviceId: string; endpoint: string },
): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, input.userId),
        eq(pushSubscriptions.deviceId, input.deviceId),
        eq(pushSubscriptions.endpoint, input.endpoint),
      ),
    );
}

export async function removePushSubscriptionsForDevice(
  db: Database,
  deviceId: string,
): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.deviceId, deviceId));
}

export async function listActiveSubscriptions(
  db: Database,
  input: { userIds: string[]; excludeDeviceId?: string },
): Promise<PushSubscriptionRow[]> {
  if (input.userIds.length === 0) return [];
  const conditions = [
    inArray(pushSubscriptions.userId, input.userIds),
    isNull(devices.revokedAt),
  ];
  if (input.excludeDeviceId) {
    conditions.push(ne(pushSubscriptions.deviceId, input.excludeDeviceId));
  }

  return db
    .select({
      id: pushSubscriptions.id,
      userId: pushSubscriptions.userId,
      deviceId: pushSubscriptions.deviceId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
      createdAt: pushSubscriptions.createdAt,
      lastSuccessAt: pushSubscriptions.lastSuccessAt,
      failureCount: pushSubscriptions.failureCount,
    })
    .from(pushSubscriptions)
    .innerJoin(devices, eq(devices.id, pushSubscriptions.deviceId))
    .where(and(...conditions));
}

/** 새 메시지 알림. 본문·발신자·파일 정보는 포함하지 않고 대화 ID만 전달한다. */
export function messagePushPayload(message: MessageRow): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: "message",
      title: "OneMoments",
      body: "새 메시지가 도착했습니다.",
      conversationId: message.conversationId,
      messageId: message.id,
      tag: `onemoments-${message.conversationId}`,
    }),
    "utf8",
  );
}

export interface MissedCallPushInput {
  calleeUserId: string;
  conversationId: string;
  callId: string;
  media: "audio" | "video";
}

/**
 * 부재중 통화 알림.
 *
 * 메시지 알림과 같은 원칙으로 발신자·대화 내용은 담지 않고 대화 ID 와 미디어 종류만 알린다.
 */
export function missedCallPushPayload(input: MissedCallPushInput): Buffer {
  const label = input.media === "video" ? "영상" : "음성";
  return Buffer.from(
    JSON.stringify({
      type: "call",
      title: "OneMoments",
      body: `부재중 ${label} 통화가 있습니다.`,
      conversationId: input.conversationId,
      callId: input.callId,
      media: input.media,
      tag: `onemoments-call-${input.conversationId}`,
    }),
    "utf8",
  );
}

/** 구독 목록으로 암호화 푸시를 보내고, 만료된 구독을 정리한다. */
async function deliverPushes(
  db: Database,
  config: Config,
  subscriptions: PushSubscriptionRow[],
  payload: Buffer,
): Promise<void> {
  const vapid = createVapidKeys(config);
  if (!vapid) return;
  await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      try {
        const status = await sendWebPush(
          subscription,
          payload,
          vapid,
          config.pushTtlSeconds,
        );
        if (status === 404 || status === 410) {
          await db
            .delete(pushSubscriptions)
            .where(eq(pushSubscriptions.id, subscription.id));
          return;
        }
        if (status >= 200 && status < 300) {
          await db
            .update(pushSubscriptions)
            .set({ lastSuccessAt: new Date(), failureCount: 0 })
            .where(eq(pushSubscriptions.id, subscription.id));
          return;
        }
        await db
          .update(pushSubscriptions)
          .set({ failureCount: subscription.failureCount + 1 })
          .where(eq(pushSubscriptions.id, subscription.id));
      } catch (error) {
        // 엔드포인트 원문은 로그에 남기지 않는다.
        console.error(
          JSON.stringify({
            level: "warn",
            event: "push_delivery_failed",
            subscriptionId: subscription.id,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }),
  );
}

export async function sendMessagePushes(
  db: Database,
  config: Config,
  input: {
    message: MessageRow;
    participantUserIds: string[];
    mutedUserIds?: string[];
    senderDeviceId: string;
  },
): Promise<void> {
  const muted = new Set(input.mutedUserIds ?? []);
  const subscriptions = (
    await listActiveSubscriptions(db, {
      userIds: input.participantUserIds,
      excludeDeviceId: input.senderDeviceId,
    })
  ).filter((subscription) => !muted.has(subscription.userId));
  if (subscriptions.length === 0) return;

  await deliverPushes(db, config, subscriptions, messagePushPayload(input.message));
}

/**
 * 부재중 통화(응답 없이 발신자가 취소·실패) 알림을 수신자의 모든 기기로 보낸다.
 *
 * 수신자가 이미 통화를 받은 경우에는 호출되지 않는다.
 */
export async function sendMissedCallPushes(
  db: Database,
  config: Config,
  input: MissedCallPushInput,
): Promise<void> {
  const subscriptions = await listActiveSubscriptions(db, { userIds: [input.calleeUserId] });
  if (subscriptions.length === 0) return;
  await deliverPushes(db, config, subscriptions, missedCallPushPayload(input));
}
