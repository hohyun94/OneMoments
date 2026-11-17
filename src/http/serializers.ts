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
  return {
    ...toPublicDevice(row),
    revokedAt: iso(row.revokedAt),
    idleTimeoutSeconds: row.idleTimeoutSeconds,
  };
}

export function toConversationSummary(
  conversation: ConversationRow,
  members: UserRow[],
  peer: UserRow | null,
  memberCount: number,
  muted: boolean,
  isAdmin: boolean,
  unreadCount: number,
  lastMessageAt: Date | string | null,
): ConversationSummary {
  return {
    id: conversation.id,
    kind: conversation.kind === "group" ? "group" : "direct",
    name: conversation.kind === "group" ? conversation.name : null,
    createdAt: conversation.createdAt.toISOString(),
    peer: peer ? toPeerUser(peer) : null,
    members: members.map(toPeerUser),
    memberCount,
    muted,
    isAdmin,
    unreadCount,
    lastMessageAt: iso(lastMessageAt),
  };
}

export function toDeviceKeyEnvelope(row: MessageKeyRow): DeviceKeyEnvelope {
  const distribution =
    row.distributionCiphertext && row.distributionNonce
      ? { ciphertext: row.distributionCiphertext, nonce: row.distributionNonce }
      : undefined;
  if (row.version === 2 && row.ratchetPublicKey) {
    return {
      deviceId: row.recipientDeviceId,
      version: 2,
      ratchetPublicKey: row.ratchetPublicKey,
      previousChainLength: row.previousChainLength ?? 0,
      messageNumber: row.messageNumber ?? 0,
      ...(row.senderIdentityPublicKey && row.signedPreKeyId
        ? {
            senderIdentityPublicKey: row.senderIdentityPublicKey,
            signedPreKeyId: row.signedPreKeyId,
          }
        : {}),
      ...(row.oneTimePreKeyId ? { oneTimePreKeyId: row.oneTimePreKeyId } : {}),
      wrappedKey: row.wrappedKey,
      wrapNonce: row.wrapNonce,
      ...(distribution ? { distribution } : {}),
    };
  }
  return {
    deviceId: row.recipientDeviceId,
    version: 1,
    ephemeralPublicKey: row.ephemeralPublicKey ?? "",
    wrappedKey: row.wrappedKey,
    wrapNonce: row.wrapNonce,
    ...(distribution ? { distribution } : {}),
  };
}

/** 평문·대화 키는 포함하지 않는다. 봉투와 서명만 전달한다. */
export function toMessageView(row: MessageRow, key: MessageKeyRow | null): MessageView {
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
    senderKeyId: row.senderKeyId,
    senderKeyIteration: row.senderKeyIteration,
    createdAt: row.createdAt.toISOString(),
    key: key ? toDeviceKeyEnvelope(key) : null,
  };
}
