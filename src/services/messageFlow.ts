import { and, eq, isNull } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { devices, type MessageKeyRow, type MessageRow } from "../db/schema.js";
import {
  normalizeMessagePayload,
  type MessagePayloadInput,
} from "../crypto/envelope.js";
import { AppError } from "../http/errors.js";
import { toMessageView } from "../http/serializers.js";
import { recordMessageCreated } from "../metrics.js";
import type { MessageView } from "../types/protocol.js";
import type { MessageEvent } from "../realtime/bus.js";
import {
  listActiveDeviceKeys,
  listMutedParticipantUserIds,
  listParticipantUserIds,
  requireParticipant,
  unhideConversation,
  type ActiveDeviceKey,
} from "./conversations.js";
import { createMessage } from "./messages.js";
import { sendMessagePushes } from "./push.js";

export interface SendEncryptedMessageInput {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  payload: MessagePayloadInput;
  kind: "text" | "reaction" | "edit";
  targetMessageId?: string | undefined;
}

export interface SendEncryptedMessageResult {
  message: MessageView;
  event: MessageEvent;
  created: boolean;
  devices: ActiveDeviceKey[];
}

function deviceKeySetsMatch(expected: ActiveDeviceKey[], provided: string[]): boolean {
  if (expected.length !== provided.length) return false;
  const expectedIds = new Set(expected.map((device) => device.id));
  const seen = new Set<string>();
  for (const id of provided) {
    if (!expectedIds.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * 메시지 1건 전송의 단일 경로(REST·WS 공용).
 * 봉투 검증 → 활성 기기 집합 일치 확인 → 저장 → 발신 기기용 뷰 생성.
 */
export async function sendEncryptedMessage(
  db: Database,
  config: Config,
  input: SendEncryptedMessageInput,
): Promise<SendEncryptedMessageResult> {
  const context = await requireParticipant(db, {
    conversationId: input.conversationId,
    userId: input.senderUserId,
  });
  if (context.peer?.deletedAt) {
    throw new AppError(403, "PEER_DELETED", "This account no longer exists");
  }

  const payload = normalizeMessagePayload(input.payload, {
    maxCiphertextBytes: config.maxCiphertextBytes,
    maxEnvelopes: config.maxEnvelopes,
  });

  const activeDevices = await listActiveDeviceKeys(db, input.conversationId);
  const activeDeviceIds = new Set(activeDevices.map((device) => device.id));
  if (payload.senderKeyId === null) {
    if (payload.keys.some((key) => key.distribution !== undefined)) {
      throw new AppError(
        400,
        "INVALID_ENVELOPE",
        "Distribution payload is only allowed for sender-key messages",
      );
    }
    if (!deviceKeySetsMatch(activeDevices, payload.keys.map((key) => key.deviceId))) {
      throw new AppError(
        409,
        "DEVICE_SET_CHANGED",
        "Re-encrypt the message for the current active devices",
        {
          devices: activeDevices.map((device) => ({
            id: device.id,
            userId: device.userId,
            identityPublicKey: device.identityPublicKey,
            signingPublicKey: device.signingPublicKey,
            signedPreKeyId: device.signedPreKeyId,
            signedPreKeyPublicKey: device.signedPreKeyPublicKey,
            signedPreKeySignature: device.signedPreKeySignature,
            oneTimePreKeyId: device.oneTimePreKeyId,
            oneTimePreKeyPublicKey: device.oneTimePreKeyPublicKey,
          })),
        },
      );
    }
  } else if (payload.keys.some((key) => !activeDeviceIds.has(key.deviceId))) {
    throw new AppError(
      409,
      "DEVICE_SET_CHANGED",
      "Sender key distribution targets an inactive device",
    );
  }

  const [senderDevice] = await db
    .select({ signingPublicKey: devices.signingPublicKey })
    .from(devices)
    .where(
      and(
        eq(devices.id, input.senderDeviceId),
        eq(devices.userId, input.senderUserId),
        isNull(devices.revokedAt),
      ),
    )
    .limit(1);
  if (!senderDevice) {
    throw new AppError(401, "UNAUTHORIZED", "Unknown sender device");
  }

  const result = await createMessage(db, {
    conversationId: input.conversationId,
    senderUserId: input.senderUserId,
    senderDeviceId: input.senderDeviceId,
    senderSigningPublicKey: senderDevice.signingPublicKey,
    payload,
    kind: input.kind,
    targetMessageId: input.targetMessageId,
  });

  const ownKey = result.keys.find(
    (key) => key.recipientDeviceId === input.senderDeviceId,
  );
  if (payload.senderKeyId === null && !ownKey) {
    throw new AppError(
      409,
      "DEVICE_SET_CHANGED",
      "This device has no envelope for the stored message",
    );
  }

  if (result.created) {
    recordMessageCreated();
    await unhideConversation(db, {
      conversationId: input.conversationId,
      userId: input.senderUserId,
    });
  }

  const participantUserIds = await listParticipantUserIds(db, input.conversationId);

  if (result.created && result.message.kind === "text") {
    const mutedUserIds = await listMutedParticipantUserIds(db, input.conversationId);
    // 알림은 응답을 막지 않는다. 실패해도 메시지 전달에는 영향을 주지 않는다.
    void sendMessagePushes(db, config, {
      message: result.message,
      participantUserIds,
      mutedUserIds,
      senderDeviceId: input.senderDeviceId,
    }).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          level: "warn",
          event: "push_dispatch_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  return {
    message: toMessageView(result.message, ownKey ?? null),
    event: {
      type: "message.created",
      conversationId: input.conversationId,
      message: result.message,
      keys: result.keys,
      participantUserIds,
    },
    created: result.created,
    devices: activeDevices,
  };
}

export type { MessageRow, MessageKeyRow };
