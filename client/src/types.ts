export interface PublicUser {
  id: string;
  username: string;
  createdAt: string;
  deleted: boolean;
  /** ADMIN_USERNAMES allowlist 에 포함된 경우에만 true */
  isAdmin?: boolean;
}

export interface PeerUser {
  id: string;
  username: string | null;
  deleted: boolean;
}

export interface Device {
  id: string;
  name: string;
  identityPublicKey: string;
  signingPublicKey: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt?: string | null;
}

export interface ConversationSummary {
  id: string;
  kind: "direct" | "group";
  name: string | null;
  createdAt: string;
  peer: PeerUser | null;
  members: PeerUser[];
  memberCount: number;
  muted: boolean;
  isAdmin: boolean;
  unreadCount: number;
  lastMessageAt: string | null;
}

export type DeviceKeyEnvelope =
  | {
      deviceId: string;
      version: 1;
      ephemeralPublicKey: string;
      wrappedKey: string;
      wrapNonce: string;
      distribution?: { ciphertext: string; nonce: string };
    }
  | {
      deviceId: string;
      version: 2;
      ratchetPublicKey: string;
      previousChainLength: number;
      messageNumber: number;
      senderIdentityPublicKey?: string;
      signedPreKeyId?: string;
      oneTimePreKeyId?: string;
      wrappedKey: string;
      wrapNonce: string;
      distribution?: { ciphertext: string; nonce: string };
    };

export interface MessageView {
  id: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  senderSigningPublicKey: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  clientMessageId: string;
  senderKeyId: string | null;
  senderKeyIteration: number | null;
  createdAt: string;
  key: DeviceKeyEnvelope | null;
}

export interface ReadReceipt {
  userId: string;
  lastReadMessageId: string;
  /** 읽음 커서 메시지의 작성 시각 */
  readAt: string;
  updatedAt: string;
}

export interface MessagePage {
  messages: MessageView[];
  nextCursor: string | null;
}

export interface ActiveDevice {
  id: string;
  userId: string;
  identityPublicKey: string;
  signingPublicKey: string;
  signedPreKeyId?: string | null;
  signedPreKeyPublicKey?: string | null;
  signedPreKeySignature?: string | null;
  oneTimePreKeyId?: string | null;
  oneTimePreKeyPublicKey?: string | null;
}

export interface AuthResponse {
  user: PublicUser;
  device: Device;
  csrfToken: string;
  expiresAt: string;
}

export interface MeResponse {
  user: PublicUser;
  deviceId: string;
  devices: Device[];
  csrfToken: string;
}

export interface AdminOverview {
  usersTotal: number;
  usersDeleted: number;
  devicesActive: number;
  devicesRevoked: number;
  directConversations: number;
  groupConversations: number;
  messages: number;
  attachments: number;
  attachmentBytes: number;
  activeSessions: number;
  pushSubscriptions: number;
  decoyProfiles: number;
  decoyProfilesDisabled: number;
}

export interface AdminUserListItem {
  id: string;
  username: string;
  createdAt: string;
  deleted: boolean;
  activeDeviceCount: number;
  activeSessionCount: number;
}

export interface AdminUserPage {
  users: AdminUserListItem[];
  nextCursor: string | null;
}

export interface AdminDeviceListItem {
  id: string;
  userId: string;
  username: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  activeSessionCount: number;
}

export interface AdminDevicePage {
  devices: AdminDeviceListItem[];
  nextCursor: string | null;
}

export interface AdminDeviceSessions {
  device: AdminDeviceListItem;
  sessions: AdminUserSession[];
}

export interface AdminUserDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface AdminUserSession {
  id: string;
  deviceId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
}

export interface AdminUserDetail {
  user: PublicUser;
  devices: AdminUserDevice[];
  sessions: AdminUserSession[];
  counts: {
    conversations: number;
    messages: number;
    attachments: number;
    pushSubscriptions: number;
  };
  decoy: { id: string; alias: string; disabledAt: string | null } | null;
}

export interface AdminAuditEntry {
  id: string;
  adminUsername: string;
  action: string;
  targetUsername: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface DecoyProfile {
  id: string;
  alias: string;
  userId: string;
  handle: string;
  disabledAt: string | null;
  createdAt: string;
}

export type ServerFrame =
  | { type: "ready"; userId: string; deviceId: string }
  | { type: "subscribed"; conversationIds: string[] }
  | { type: "unsubscribed"; conversationIds: string[] }
  | { type: "message.created"; message: MessageView }
  | { type: "message.ack"; clientMessageId: string; message: MessageView }
  | { type: "typing"; conversationId: string; userId: string; state: "start" | "stop" }
  | {
      type: "presence";
      conversationId: string;
      userId: string;
      state: "online" | "offline";
    }
  | { type: "pong"; at: string }
  | { type: "error"; code: string; message: string; clientMessageId?: string };
