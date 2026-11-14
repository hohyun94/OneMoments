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
  const vapid = createVapidKeys(config);
  if (!vapid) return;

  const muted = new Set(input.mutedUserIds ?? []);
  const subscriptions = (
    await listActiveSubscriptions(db, {
      userIds: input.participantUserIds,
      excludeDeviceId: input.senderDeviceId,
    })
  ).filter((subscription) => !muted.has(subscription.userId));
  if (subscriptions.length === 0) return;

  const payload = messagePushPayload(input.message);
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
