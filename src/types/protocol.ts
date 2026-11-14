/** REST·WebSocket 공통 와이어 타입. */

export interface PublicUser {
  id: string;
  username: string;
  createdAt: string;
  deleted: boolean;
}

export interface PeerUser {
  id: string;
  /** 계정이 삭제(익명화)되면 null */
  username: string | null;
  deleted: boolean;
}

export interface PublicDevice {
  id: string;
  name: string;
  identityPublicKey: string;
  signingPublicKey: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface OwnDevice extends PublicDevice {
  revokedAt: string | null;
}

export interface ConversationSummary {
  id: string;
  kind: "direct" | "group";
  /** 그룹 이름. 1:1 은 null */
  name: string | null;
  createdAt: string;
  /** 1:1 상대. 그룹은 null */
  peer: PeerUser | null;
  /** 나를 제외한 참여자(그룹 포함) */
  members: PeerUser[];
  /** 나를 포함한 전체 인원 */
  memberCount: number;
  /** 이 대화의 푸시 알림을 끈 상태 */
  muted: boolean;
  lastMessageAt: string | null;
}

export type DeviceKeyEnvelope =
  | {
      deviceId: string;
      version: 1;
      ephemeralPublicKey: string;
      wrappedKey: string;
      wrapNonce: string;
    }
  | {
      deviceId: string;
      version: 2;
      ratchetPublicKey: string;
      previousChainLength: number;
      messageNumber: number;
      wrappedKey: string;
      wrapNonce: string;
    };

/** 서버가 보관·중계하는 메시지 + 내 기기 봉투. 서버는 복호화하지 않는다. */
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
  createdAt: string;
  key: DeviceKeyEnvelope;
}

export interface DeviceKeySet {
  devices: Array<{
    id: string;
    userId: string;
    identityPublicKey: string;
    signingPublicKey: string;
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
  | { type: "ping" };

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
