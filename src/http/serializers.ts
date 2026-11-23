import type {
  ConversationRow,
  DeviceRow,
  MessageKeyRow,
  MessageRow,
  MomentKeyRow,
  MomentRow,
  UserRow,
} from "../db/schema.js";
import type {
  ConversationSummary,
  DeviceKeyEnvelope,
  MessageView,
  MomentView,
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
    statusMessage: row.statusMessage,
    createdAt: row.createdAt.toISOString(),
    deleted: row.deletedAt !== null,
  };
}

export function toPeerUser(row: UserRow): PeerUser {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    username: deleted ? null : row.username,
    statusMessage: deleted ? null : row.statusMessage,
    deleted,
  };
}

export function toPublicDevice(row: DeviceRow): PublicDevice {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
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
  favorite: boolean,
  blocked: "me" | "peer" | null,
  missedCallCount = 0,
): ConversationSummary {
  return {
    id: conversation.id,
    kind: conversation.kind === "group" ? "group" : "direct",
    name: conversation.kind === "group" ? conversation.name : null,
    createdAt: conversation.createdAt.toISOString(),
    autoDeleteAfterReadSeconds: conversation.autoDeleteAfterReadSeconds,
    peer: peer ? toPeerUser(peer) : null,
    members: members.map(toPeerUser),
    memberCount,
    muted,
    isAdmin,
    favorite,
    blocked,
    unreadCount,
    missedCallCount,
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
    kind: row.kind as "text" | "reaction" | "edit",
    targetMessageId: row.targetMessageId,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    signature: row.signature,
    clientMessageId: row.clientMessageId,
    senderKeyId: row.senderKeyId,
    senderKeyIteration: row.senderKeyIteration,
    pinned: row.pinnedAt !== null,
    createdAt: row.createdAt.toISOString(),
    key: key ? toDeviceKeyEnvelope(key) : null,
  };
}

export function toMomentDeviceKey(row: MomentKeyRow): DeviceKeyEnvelope {
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
    };
  }
  return {
    deviceId: row.recipientDeviceId,
    version: 1,
    ephemeralPublicKey: row.ephemeralPublicKey ?? "",
    wrappedKey: row.wrappedKey,
    wrapNonce: row.wrapNonce,
  };
}

export function toMomentView(
  moment: MomentRow,
  author: UserRow,
  key: MomentKeyRow | null,
  extras: { viewCount?: number; viewed?: boolean } = {},
): MomentView {
  return {
    id: moment.id,
    author: toPeerUser(author),
    authorSigningPublicKey: moment.authorSigningPublicKey,
    ciphertext: moment.ciphertext,
    nonce: moment.nonce,
    signature: moment.signature,
    createdAt: moment.createdAt.toISOString(),
    expiresAt: moment.expiresAt.toISOString(),
    key: key ? toMomentDeviceKey(key) : null,
    ...(extras.viewCount !== undefined ? { viewCount: extras.viewCount } : {}),
    ...(extras.viewed !== undefined ? { viewed: extras.viewed } : {}),
  };
}
