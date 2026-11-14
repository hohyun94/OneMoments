export interface PublicUser {
  id: string;
  username: string;
  createdAt: string;
  deleted: boolean;
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

export interface MessagePage {
  messages: MessageView[];
  nextCursor: string | null;
}

export interface ActiveDevice {
  id: string;
  userId: string;
  identityPublicKey: string;
  signingPublicKey: string;
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
