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
  listParticipantUserIds,
  requireParticipant,
  unhideConversation,
  type ActiveDeviceKey,
} from "./conversations.js";
import { createMessage } from "./messages.js";

export interface SendEncryptedMessageInput {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  payload: MessagePayloadInput;
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
  if (context.peer.deletedAt !== null) {
    throw new AppError(403, "PEER_DELETED", "This account no longer exists");
  }

  const payload = normalizeMessagePayload(input.payload, {
    maxCiphertextBytes: config.maxCiphertextBytes,
    maxEnvelopes: config.maxEnvelopes,
  });

  const activeDevices = await listActiveDeviceKeys(db, input.conversationId);
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
        })),
      },
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
  });

  const ownKey = result.keys.find(
    (key) => key.recipientDeviceId === input.senderDeviceId,
  );
  if (!ownKey) {
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

  return {
    message: toMessageView(result.message, ownKey),
    event: {
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
