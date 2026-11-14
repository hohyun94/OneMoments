import type {
  ConversationRow,
  DeviceRow,
  MessageKeyRow,
  MessageRow,
  UserRow,
} from "../db/schema.js";
import type {
  ConversationSummary,
  DeviceKeyEnvelope,
  MessageView,
  OwnDevice,
  PeerUser,
  PublicDevice,
  PublicUser,
} from "../types/protocol.js";

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    createdAt: row.createdAt.toISOString(),
    deleted: row.deletedAt !== null,
  };
}

export function toPeerUser(row: UserRow): PeerUser {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    username: deleted ? null : row.username,
    deleted,
  };
}

export function toPublicDevice(row: DeviceRow): PublicDevice {
  return {
    id: row.id,
    name: row.name,
    identityPublicKey: row.identityPublicKey,
    signingPublicKey: row.signingPublicKey,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: iso(row.lastSeenAt),
  };
}

export function toOwnDevice(row: DeviceRow): OwnDevice {
  return { ...toPublicDevice(row), revokedAt: iso(row.revokedAt) };
}

export function toConversationSummary(
  conversation: ConversationRow,
  peer: UserRow,
  lastMessageAt: Date | string | null,
): ConversationSummary {
  return {
    id: conversation.id,
    createdAt: conversation.createdAt.toISOString(),
    peer: toPeerUser(peer),
    lastMessageAt: iso(lastMessageAt),
  };
}

export function toDeviceKeyEnvelope(row: MessageKeyRow): DeviceKeyEnvelope {
  return {
    deviceId: row.recipientDeviceId,
    ephemeralPublicKey: row.ephemeralPublicKey,
    wrappedKey: row.wrappedKey,
    wrapNonce: row.wrapNonce,
    version: 1,
  };
}

/** 평문·대화 키는 포함하지 않는다. 봉투와 서명만 전달한다. */
export function toMessageView(row: MessageRow, key: MessageKeyRow): MessageView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderUserId: row.senderUserId,
    senderDeviceId: row.senderDeviceId,
    senderSigningPublicKey: row.senderSigningPublicKey,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    signature: row.signature,
    clientMessageId: row.clientMessageId,
    createdAt: row.createdAt.toISOString(),
    key: toDeviceKeyEnvelope(key),
  };
}
