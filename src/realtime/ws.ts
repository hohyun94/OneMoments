import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import { SESSION_COOKIE } from "../auth/session.js";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { AppError } from "../http/errors.js";
import { recordWsConnection } from "../metrics.js";
import { resolveSession, type AuthContext } from "../http/middleware.js";
import { toMessageView } from "../http/serializers.js";
import { touchDevice } from "../services/accounts.js";
import { isParticipant, requireDirectCallPeer } from "../services/conversations.js";
import { finishCallLog, markCallAnswered, startCallLog } from "../services/calls.js";
import { sendEncryptedMessage } from "../services/messageFlow.js";
import {
  WS_PATH,
  type CallServerFrame,
  type ClientFrame,
  type ServerFrame,
} from "../types/protocol.js";
import type { MessageBus } from "./bus.js";
import { ChatHub, type ChatConnection } from "./hub.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const FRAME_WINDOW_MS = 10_000;
const MAX_FRAMES_PER_WINDOW = 120;
const conversationId = z.string().uuid();
const envelopeKey = z.object({
  deviceId: z.string().uuid(),
  ephemeralPublicKey: z.string().min(1).optional(),
  ratchetPublicKey: z.string().min(1).optional(),
  previousChainLength: z.number().int().min(0).optional(),
  messageNumber: z.number().int().min(0).optional(),
  senderIdentityPublicKey: z.string().min(1).optional(),
  signedPreKeyId: z.string().uuid().optional(),
  oneTimePreKeyId: z.string().uuid().optional(),
  wrappedKey: z.string().min(1),
  wrapNonce: z.string().min(1),
  distributionCiphertext: z.string().min(1).optional(),
  distributionNonce: z.string().min(1).optional(),
  distribution: z
    .object({ ciphertext: z.string().min(1), nonce: z.string().min(1) })
    .optional(),
  version: z.number().int().optional(),
});

const clientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), conversationIds: z.array(conversationId).max(200) }),
  z.object({ type: z.literal("unsubscribe"), conversationIds: z.array(conversationId).max(200) }),
  z.object({
    type: z.literal("message.send"),
    conversationId,
    clientMessageId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    kind: z.enum(["text", "reaction", "edit"]).default("text"),
    targetMessageId: z.string().uuid().optional(),
    ciphertext: z.string().min(1),
    nonce: z.string().min(1),
    signature: z.string().min(1),
    keys: z.array(envelopeKey).max(200),
    senderKeyId: z.string().uuid().optional(),
    senderKeyIteration: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal("typing"),
    conversationId,
    state: z.enum(["start", "stop"]),
  }),
  // 1:1 음성 통화 시그널링. SDP/ICE 는 서버가 해석하지 않고 그대로 중계한다.
  z.object({
    type: z.literal("call.invite"),
    conversationId,
    callId: z.string().uuid(),
    media: z.literal("audio"),
  }),
  z.object({
    type: z.literal("call.accept"),
    conversationId,
    callId: z.string().uuid(),
    media: z.literal("audio"),
  }),
  z.object({
    type: z.literal("call.decline"),
    conversationId,
    callId: z.string().uuid(),
    reason: z.enum(["declined", "busy", "unsupported"]).optional(),
  }),
  z.object({
    type: z.literal("call.cancel"),
    conversationId,
    callId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("call.end"),
    conversationId,
    callId: z.string().uuid(),
    reason: z.enum(["hangup", "failed", "timeout"]).optional(),
  }),
  z.object({
    type: z.literal("call.signal"),
    conversationId,
    callId: z.string().uuid(),
    signal: z
      .object({
        description: z
          .object({
            type: z.enum(["offer", "answer", "pranswer", "rollback"]),
            sdp: z.string().min(1).max(64_000),
          })
          .optional(),
        candidate: z
          .object({
            candidate: z.string().min(1).max(2_000),
            sdpMid: z.string().max(64).nullish(),
            sdpMLineIndex: z.number().int().min(0).max(65_535).nullish(),
            usernameFragment: z.string().max(256).nullish(),
          })
          .optional(),
      })
      .refine((value) => Boolean(value.description || value.candidate), {
        message: "signal must include description or candidate",
      }),
  }),
  z.object({ type: z.literal("ping") }),
]);

export interface RealtimeOptions {
  server: Server;
  db: Database;
  config: Config;
  bus: MessageBus;
}

export interface RealtimeHandle {
  hub: ChatHub;
  close: () => Promise<void>;
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

function originAllowed(req: IncomingMessage, config: Config): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.corsOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createRealtime(options: RealtimeOptions): RealtimeHandle {
  const { server, db, config, bus } = options;
  const hub = new ChatHub();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Math.ceil(config.maxCiphertextBytes * 2) + 64 * 1024,
  });

  const alive = new Map<WebSocket, boolean>();
  const frameLog = new Map<WebSocket, number[]>();

  const unsubscribeBus = bus.subscribe((event) => {
    if (event.type === "call.relay") {
      // 시그널링은 저장하지 않고 참여자 연결로만 전달한다(발신 기기에는 되돌리지 않는다).
      for (const connection of hub.connectionsForUsers(event.participantUserIds)) {
        if (connection.deviceId === event.fromDeviceId) continue;
        hub.send(connection.socket, event.frame);
      }
      return;
    }
    if (event.type === "message.deleted") {
      for (const connection of hub.connectionsForUsers(event.participantUserIds)) {
        hub.send(connection.socket, {
          type: "message.deleted",
          conversationId: event.conversationId,
          messageIds: event.messageIds,
        });
      }
      return;
    }
    if (event.type === "message.hidden") {
      // 나에게만 삭제: 해당 사용자의 연결된 기기에만 로컬 제거를 알린다.
      for (const connection of hub.connectionsForUsers([event.userId])) {
        hub.send(connection.socket, {
          type: "message.deleted",
          conversationId: event.conversationId,
          messageIds: event.messageIds,
        });
      }
      return;
    }
    // 구독하지 않은 참여자 연결에도 전달해 대화 목록이 즉시 갱신되게 한다.
    for (const connection of hub.connectionsForUsers(event.participantUserIds)) {
      // sender-key 메시지는 발신 기기에 봉투가 없으므로 REST 응답으로만 표시한다.
      if (
        event.message.senderKeyId &&
        connection.deviceId === event.message.senderDeviceId
      ) {
        continue;
      }
      const key = event.keys.find(
        (candidate) => candidate.recipientDeviceId === connection.deviceId,
      );
      if (!key && !event.message.senderKeyId) continue;
      hub.send(connection.socket, {
        type: "message.created",
        message: toMessageView(event.message, key ?? null),
      });
    }
  });

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (url.pathname !== WS_PATH) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!originAllowed(req, config)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    resolveSession(db, token)
      .then((auth) => {
        if (socket.destroyed) return;
        if (!auth) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          onConnection(ws, auth);
        });
      })
      .catch(() => rejectUpgrade(socket, 401, "Unauthorized"));
  };
  server.on("upgrade", upgradeHandler);

  const heartbeat = setInterval(() => {
    for (const [socket, isAlive] of alive) {
      if (!isAlive) {
        socket.terminate();
        alive.delete(socket);
        frameLog.delete(socket);
        continue;
      }
      alive.set(socket, false);
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  function onConnection(socket: WebSocket, auth: AuthContext): void {
    const connection = hub.add(socket, auth.userId, auth.deviceId);
    alive.set(socket, true);
    frameLog.set(socket, []);
    recordWsConnection(1);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      hub.remove(socket);
      alive.delete(socket);
      frameLog.delete(socket);
      recordWsConnection(-1);
    };

    hub.send(socket, { type: "ready", userId: auth.userId, deviceId: auth.deviceId });
    void touchDevice(db, auth.deviceId).catch(() => undefined);

    socket.on("pong", () => alive.set(socket, true));
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        hub.send(socket, {
          type: "error",
          code: "INVALID_FRAME",
          message: "Binary frames are not supported",
        });
        return;
      }
      void handleMessage(connection, data.toString());
    });
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  function sendError(
    socket: WebSocket,
    code: string,
    message: string,
    clientMessageId?: string,
  ): void {
    const frame: ServerFrame = clientMessageId
      ? { type: "error", code, message, clientMessageId }
      : { type: "error", code, message };
    hub.send(socket, frame);
  }

  async function handleMessage(connection: ChatConnection, raw: string): Promise<void> {
    const socket = connection.socket;
    const now = Date.now();
    const recent = (frameLog.get(socket) ?? []).filter((stamp) => now - stamp < FRAME_WINDOW_MS);
    recent.push(now);
    frameLog.set(socket, recent);
    if (recent.length > MAX_FRAMES_PER_WINDOW) {
      sendError(socket, "RATE_LIMITED", "Too many frames");
      socket.close(4429, "Rate limit exceeded");
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      sendError(socket, "INVALID_JSON", "Frame must be valid JSON");
      return;
    }

    const parsed = clientFrameSchema.safeParse(payload);
    if (!parsed.success) {
      sendError(socket, "INVALID_FRAME", "Frame does not match the protocol");
      return;
    }
    const frame: ClientFrame = parsed.data;

    try {
      switch (frame.type) {
        case "ping": {
          hub.send(socket, { type: "pong", at: new Date().toISOString() });
          return;
        }
        case "subscribe": {
          const allowed: string[] = [];
          for (const id of frame.conversationIds) {
            if (await isParticipant(db, { conversationId: id, userId: connection.userId })) {
              allowed.push(id);
            }
          }
          const joined = hub.subscribe(connection, allowed);
          // 새로 구독한 연결에는 이미 온라인인 참여자의 presence 를 스냅샷으로 보낸다.
          // (이벤트만 보내면 늦게 접속한 쪽은 상대를 계속 오프라인으로 본다.)
          for (const id of joined) {
            for (const userId of hub.onlineUserIds(id)) {
              if (userId === connection.userId) continue;
              hub.send(socket, {
                type: "presence",
                conversationId: id,
                userId,
                state: "online",
              });
            }
          }
          hub.send(socket, { type: "subscribed", conversationIds: joined });
          return;
        }
        case "unsubscribe": {
          const left = hub.unsubscribe(connection, frame.conversationIds);
          hub.send(socket, { type: "unsubscribed", conversationIds: left });
          return;
        }
        case "typing": {
          if (!(await isParticipant(db, {
            conversationId: frame.conversationId,
            userId: connection.userId,
          }))) {
            throw AppError.notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
          }
          hub.broadcast(
            frame.conversationId,
            {
              type: "typing",
              conversationId: frame.conversationId,
              userId: connection.userId,
              state: frame.state,
            },
            socket,
          );
          return;
        }
        case "message.send": {
          const result = await sendEncryptedMessage(db, config, {
            conversationId: frame.conversationId,
            senderUserId: connection.userId,
            senderDeviceId: connection.deviceId,
            payload: frame,
            kind: frame.kind ?? "text",
            targetMessageId: frame.targetMessageId,
          });
          hub.send(socket, {
            type: "message.ack",
            clientMessageId: frame.clientMessageId,
            message: result.message,
          });
          if (result.created) bus.publish(result.event);
          return;
        }
        case "call.invite":
        case "call.accept":
        case "call.decline":
        case "call.cancel":
        case "call.end":
        case "call.signal": {
          if (!config.calls.enabled) {
            throw AppError.forbidden("Voice calls are disabled");
          }
          const { participantUserIds, peerUserId } = await requireDirectCallPeer(db, {
            conversationId: frame.conversationId,
            userId: connection.userId,
          });
          const base = {
            conversationId: frame.conversationId,
            callId: frame.callId,
            fromUserId: connection.userId,
            fromDeviceId: connection.deviceId,
          };
          let relayed: CallServerFrame;
          switch (frame.type) {
            case "call.invite":
              relayed = {
                type: "call.invite",
                ...base,
                media: frame.media,
                createdAt: new Date().toISOString(),
              };
              break;
            case "call.accept":
              relayed = { type: "call.accepted", ...base, media: frame.media };
              break;
            case "call.decline":
              relayed = { type: "call.declined", ...base, reason: frame.reason ?? "declined" };
              break;
            case "call.cancel":
              relayed = { type: "call.cancelled", ...base };
              break;
            case "call.end":
              relayed = { type: "call.ended", ...base, reason: frame.reason ?? "hangup" };
              break;
            default:
              relayed = { type: "call.signal", ...base, signal: frame.signal };
              break;
          }
          bus.publish({
            type: "call.relay",
            conversationId: frame.conversationId,
            participantUserIds,
            fromDeviceId: connection.deviceId,
            frame: relayed,
          });
          // 통화 기록(메타데이터만). 실패해도 시그널링은 계속 진행한다.
          if (frame.type === "call.invite") {
            void startCallLog(db, {
              callId: frame.callId,
              conversationId: frame.conversationId,
              callerUserId: connection.userId,
              calleeUserId: peerUserId,
            }).catch(() => undefined);
          } else if (frame.type === "call.accept") {
            void markCallAnswered(db, { callId: frame.callId }).catch(() => undefined);
          } else if (frame.type === "call.decline" || frame.type === "call.cancel" || frame.type === "call.end") {
            void finishCallLog(db, {
              callId: frame.callId,
              event:
                frame.type === "call.decline"
                  ? "decline"
                  : frame.type === "call.cancel"
                    ? "cancel"
                    : "end",
              userId: connection.userId,
              reason: "reason" in frame ? frame.reason : undefined,
            }).catch(() => undefined);
          }
          return;
        }
      }
    } catch (error) {
      if (error instanceof AppError) {
        sendError(
          socket,
          error.code,
          error.message,
          frame.type === "message.send" ? frame.clientMessageId : undefined,
        );
        return;
      }
      console.error(
        JSON.stringify({
          level: "error",
          event: "ws_frame_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      sendError(socket, "INTERNAL_ERROR", "Internal server error");
    }
  }

  async function close(): Promise<void> {
    clearInterval(heartbeat);
    unsubscribeBus();
    server.off("upgrade", upgradeHandler);
    hub.closeAll();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  return { hub, close };
}
