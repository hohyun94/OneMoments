/** REST·WebSocket 공통 와이어 타입. */

export interface PublicUser {
  id: string;
  username: string;
  statusMessage: string | null;
  /** 공개 프로필 아바타가 있으면 마지막 변경 시각(캐시 무효화용) */
  avatarUpdatedAt: string | null;
  /** 마지막 접속 시각 공개(옵트인) 여부. 내 프로필에서만 의미가 있다 */
  lastSeenVisible: boolean;
  createdAt: string;
  deleted: boolean;
  /** ADMIN_USERNAMES allowlist 에 포함된 경우에만 true */
  isAdmin?: boolean;
}

export type ThemeMode = "light" | "dark" | "system";

/** 계정에 저장되는 화면 테마. accent 는 프리셋 ID 또는 #rrggbb. */
export interface ThemeSettings {
  mode: ThemeMode;
  accent: string;
}

export interface PeerUser {
  id: string;
  /** 계정이 삭제(익명화)되면 null */
  username: string | null;
  statusMessage: string | null;
  /** 공개 프로필 아바타가 있으면 마지막 변경 시각(없으면 null) */
  avatarUpdatedAt: string | null;
  /** 마지막 접속 시각. 상대가 공개를 켜지 않았거나 삭제된 계정이면 null */
  lastSeenAt: string | null;
  deleted: boolean;
}

/** 클라이언트가 자기 신고하는 플랫폼(보안 판단에는 사용하지 않는다). */
export type DevicePlatform = "ios" | "android" | "mobile" | "desktop" | "unknown";

export interface PublicDevice {
  id: string;
  name: string;
  platform: DevicePlatform;
  identityPublicKey: string;
  signingPublicKey: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface OwnDevice extends PublicDevice {
  revokedAt: string | null;
  /** 기기 기본 무활동 로그아웃(초). 세션 오버라이드가 있으면 그 값이 우선한다. */
  idleTimeoutSeconds: number;
}

export interface ConversationSummary {
  id: string;
  kind: "direct" | "group";
  /** 그룹 이름. 1:1 은 null */
  name: string | null;
  createdAt: string;
  /** 참여자 모두가 읽은 뒤 자동 삭제까지의 초. null 이면 끔 */
  autoDeleteAfterReadSeconds: number | null;
  /** 1:1 상대. 그룹은 null */
  peer: PeerUser | null;
  /** 나를 제외한 참여자(그룹 포함) */
  members: PeerUser[];
  /** 나를 포함한 전체 인원 */
  memberCount: number;
  /** 이 대화의 푸시 알림을 끈 상태 */
  muted: boolean;
  /** 그룹 소유자(이름 변경·참여자 추가 가능) */
  isAdmin: boolean;
  /** 1:1 상대를 즐겨찾기했는지(내 기준) */
  favorite: boolean;
  /** 1:1 차단 상태. null 이면 차단 없음 */
  blocked: "me" | "peer" | null;
  /** 읽지 않은(내가 보내지 않은) 메시지 수 */
  unreadCount: number;
  /** 아직 확인하지 않은 부재중 통화 수(수신자 기준) */
  missedCallCount: number;
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

/** 서버가 보관·중계하는 메시지 + 내 기기 봉투. 서버는 복호화하지 않는다. */
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
  /** 한 번 보기: 수신자가 열람하면 서버에서 삭제된다. */
  viewOnce: boolean;
  createdAt: string;
  key: DeviceKeyEnvelope | null;
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
  /** 내 기기 봉투. 새 기기처럼 없으면 null 이다. */
  key: DeviceKeyEnvelope | null;
  /** 작성자에게만 제공되는 조회 수 */
  viewCount?: number;
  /** 내가 이미 조회했는지 */
  viewed?: boolean;
}

export interface ContactView {
  id: string;
  username: string;
  statusMessage: string | null;
  avatarUpdatedAt: string | null;
  favorite: boolean;
  blockedByMe: boolean;
  blockedMe: boolean;
}

export interface DeviceKeySet {
  devices: Array<{
    id: string;
    userId: string;
    identityPublicKey: string;
    signingPublicKey: string;
    signedPreKeyId?: string | null;
    signedPreKeyPublicKey?: string | null;
    signedPreKeySignature?: string | null;
    oneTimePreKeyId?: string | null;
    oneTimePreKeyPublicKey?: string | null;
  }>;
}

export const WS_PATH = "/ws";

export type ClientFrame =
  | { type: "subscribe"; conversationIds: string[] }
  | { type: "unsubscribe"; conversationIds: string[] }
  | {
      type: "message.send";
      conversationId: string;
      clientMessageId: string;
      kind?: "text" | "reaction" | "edit";
      /** 한 번 보기(수신자 열람 시 삭제) */
      viewOnce?: boolean;
      targetMessageId?: string;
      ciphertext: string;
      nonce: string;
      signature: string;
      keys: Array<{
        deviceId: string;
        ephemeralPublicKey?: string;
        ratchetPublicKey?: string;
        previousChainLength?: number;
        messageNumber?: number;
        wrappedKey: string;
        wrapNonce: string;
        version?: number;
      }>;
    }
  | { type: "typing"; conversationId: string; state: "start" | "stop" }
  | { type: "call.invite"; conversationId: string; callId: string; media: CallMedia }
  | { type: "call.accept"; conversationId: string; callId: string; media: CallMedia }
  | {
      type: "call.decline";
      conversationId: string;
      callId: string;
      reason?: CallDeclineReason;
    }
  | { type: "call.cancel"; conversationId: string; callId: string }
  | {
      type: "call.end";
      conversationId: string;
      callId: string;
      reason?: CallEndReason;
    }
  | {
      type: "call.signal";
      conversationId: string;
      callId: string;
      signal: CallSignal;
    }
  | {
      /** 화면 공유 시작/중지 알림(미디어는 흐르지 않고 상태만 알린다). */
      type: "call.screen";
      conversationId: string;
      callId: string;
      sharing: boolean;
    }
  | { type: "ping" };

/** 1:1 통화 미디어. 오디오와 영상(카메라 포함)을 지원한다. */
export type CallMedia = "audio" | "video";

export type CallDeclineReason = "declined" | "busy" | "unsupported";
export type CallEndReason = "hangup" | "failed" | "timeout";

/** SDP/ICE 는 서버가 해석하지 않고 그대로 중계한다. */
export interface CallSignal {
  description?: {
    type: "offer" | "answer" | "pranswer" | "rollback";
    sdp: string;
  };
  candidate?: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
  };
}

/** 서버가 참여자에게 중계하는 통화 이벤트(발신자·발신 기기 포함). */
export type CallServerFrame =
  | {
      type: "call.invite";
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      media: CallMedia;
      createdAt: string;
    }
  | {
      type: "call.accepted";
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      media: CallMedia;
    }
  | {
      type: "call.declined";
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      reason?: CallDeclineReason;
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
      reason?: CallEndReason;
    }
  | {
      type: "call.signal";
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      signal: CallSignal;
    }
  | {
      type: "call.screen";
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      sharing: boolean;
    };

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
  | { type: "pong"; at: string }
  | CallServerFrame
  | { type: "error"; code: string; message: string; clientMessageId?: string };
