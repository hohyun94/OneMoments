import type { ThemeSettings } from "./lib/theme.ts";

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
  /** 기기 기본 무활동 로그아웃(초). 공개 기기 응답에는 포함되지 않는다. */
  idleTimeoutSeconds?: number;
}

export interface ConversationSummary {
  id: string;
  kind: "direct" | "group";
  name: string | null;
  createdAt: string;
  /** 참여자 모두가 읽은 뒤 자동 삭제까지의 초. null 이면 끔 */
  autoDeleteAfterReadSeconds: number | null;
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
  /** 이 기기의 기본 무활동 로그아웃(초). */
  idleTimeoutSeconds?: number;
  /** 계정에 저장된 화면 테마. */
  theme: ThemeSettings;
}

export interface MeResponse {
  user: PublicUser;
  deviceId: string;
  devices: Device[];
  csrfToken: string;
  /** 실제 적용되는 무활동 로그아웃(초). 세션 오버라이드가 있으면 그 값. */
  idleTimeoutSeconds: number;
  /** 이 기기의 기본값(초). */
  deviceIdleTimeoutSeconds: number;
  /** 이번 로그인에만 적용하는 값(초). null 이면 기기 기본값. */
  sessionIdleTimeoutSeconds: number | null;
  /** 계정에 저장된 화면 테마. */
  theme: ThemeSettings;
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
