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
  createdAt: string;
  peer: PeerUser;
  lastMessageAt: string | null;
}

export interface DeviceKeyEnvelope {
  deviceId: string;
  ephemeralPublicKey: string;
  wrappedKey: string;
  wrapNonce: string;
  version: 1;
}

/** 서버가 보관·중계하는 메시지 + 내 기기 봉투. 서버는 복호화하지 않는다. */
export interface MessageView {
  id: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
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
        ephemeralPublicKey: string;
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
