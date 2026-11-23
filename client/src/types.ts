import type { DevicePlatform } from "./lib/device.ts";
import type { ThemeSettings } from "./lib/theme.ts";

export interface PublicUser {
  id: string;
  username: string;
  statusMessage: string | null;
  createdAt: string;
  deleted: boolean;
  /** ADMIN_USERNAMES allowlist 에 포함된 경우에만 true */
  isAdmin?: boolean;
}

export interface PeerUser {
  id: string;
  username: string | null;
  statusMessage: string | null;
  deleted: boolean;
}

export interface Device {
  id: string;
  name: string;
  platform: DevicePlatform;
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
  /** 1:1 상대를 즐겨찾기했는지(내 기준) */
  favorite: boolean;
  /** 1:1 차단 상태. null 이면 차단 없음 */
  blocked: "me" | "peer" | null;
  unreadCount: number;
  lastMessageAt: string | null;
}

export interface ContactView {
  id: string;
  username: string;
  statusMessage: string | null;
  favorite: boolean;
  blockedByMe: boolean;
  blockedMe: boolean;
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

export interface ReactionSummary {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface MomentDevice {
  id: string;
  identityPublicKey: string;
  signingPublicKey: string;
  signedPreKeyId?: string | null;
  signedPreKeyPublicKey?: string | null;
  signedPreKeySignature?: string | null;
  oneTimePreKeyId?: string | null;
  oneTimePreKeyPublicKey?: string | null;
}

export interface MomentContact {
  id: string;
  username: string;
  devices: MomentDevice[];
}

export interface MomentView {
  id: string;
  author: PeerUser;
  authorSigningPublicKey: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  createdAt: string;
  expiresAt: string;
  key: DeviceKeyEnvelope | null;
  viewCount?: number;
  viewed?: boolean;
}

export interface MessageView {
  id: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  senderSigningPublicKey: string;
  /** text: 일반/답장, reaction: 이모지 반응, edit: 수정 이벤트 */
  kind: "text" | "reaction" | "edit";
  /** 반응/수정/답장의 대상 메시지 */
  targetMessageId: string | null;
  ciphertext: string;
  nonce: string;
  signature: string;
  clientMessageId: string;
  senderKeyId: string | null;
  senderKeyIteration: number | null;
  /** 대화 상단에 고정되었는지(메타데이터). */
  pinned: boolean;
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
  /** 비밀번호 로그인 가능 여부(Google 전용 계정은 false). */
  hasPassword?: boolean;
  /** Google 계정 연결 여부. */
  googleLinked?: boolean;
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
  /** 서버에 Google OAuth 설정이 있는지. */
  oauthEnabled?: boolean;
  /** 이 계정에 Google 이 연결되어 있는지. */
  googleLinked?: boolean;
  /** 비밀번호 로그인 가능 여부(Google 전용 계정은 false). */
  hasPassword?: boolean;
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

export interface AdminAuthEvent {
  id: string;
  event: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface AdminAuthEventPage {
  events: AdminAuthEvent[];
  nextCursor: string | null;
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
  | { type: "message.deleted"; conversationId: string; messageIds: string[] }
  | { type: "message.ack"; clientMessageId: string; message: MessageView }
  | { type: "typing"; conversationId: string; userId: string; state: "start" | "stop" }
  | {
      type: "presence";
      conversationId: string;
      userId: string;
      state: "online" | "offline";
    }
  | CallServerFrame
  | { type: "pong"; at: string }
  | { type: "error"; code: string; message: string; clientMessageId?: string };

/** 서버가 중계하는 1:1 음성 통화 이벤트. */
export type CallServerFrame =
  | {
      type: "call.invite";
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      media: "audio";
      createdAt: string;
    }
  | {
      type: "call.accepted";
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      media: "audio";
    }
  | {
      type: "call.declined";
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      reason?: "declined" | "busy" | "unsupported";
    }
  | {
      type: "call.cancelled";
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
    }
  | {
      type: "call.ended";
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      reason?: "hangup" | "failed" | "timeout";
    }
  | {
      type: "call.signal";
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      signal: CallSignal;
    };

/** SDP/ICE 는 서버가 해석하지 않고 그대로 중계된다. */
export interface CallSignal {
  description?: { type: "offer" | "answer" | "pranswer" | "rollback"; sdp: string };
  candidate?: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
  };
}

/** `GET /api/conversations/:id/calls` 응답 항목. */
export interface CallLogEntry {
  id: string;
  callId: string;
  status: "ringing" | "completed" | "missed" | "declined" | "cancelled" | "failed";
  direction: "outgoing" | "incoming";
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
}

/** `GET /api/call/config` 응답. */
export interface CallConfig {
  enabled: boolean;
  iceServers: RTCIceServer[];
  ringTimeoutSeconds: number;
  media: "audio";
}
