import { randomUUID } from "node:crypto";

import { createClient } from "redis";

import type { MessageKeyRow, MessageRow } from "../db/schema.js";
import type { CallServerFrame } from "../types/protocol.js";

export interface MessageEvent {
  type: "message.created";
  conversationId: string;
  message: MessageRow;
  keys: MessageKeyRow[];
  participantUserIds: string[];
}

export interface MessageDeletedEvent {
  type: "message.deleted";
  conversationId: string;
  messageIds: string[];
  participantUserIds: string[];
}

/** 한 사용자에게서만 메시지를 숨겼을 때 그 사용자의 다른 기기에 알린다. */
export interface MessageHiddenEvent {
  type: "message.hidden";
  conversationId: string;
  messageIds: string[];
  userId: string;
}

/**
 * 통화 시그널링 중계(서버는 저장하지 않는다).
 * 대화 참여자 전원의 연결로 보내되 발신 기기(deviceId)에는 되돌리지 않는다.
 */
export interface CallEvent {
  type: "call.relay";
  conversationId: string;
  participantUserIds: string[];
  fromDeviceId: string;
  frame: CallServerFrame;
}

export type RealtimeEvent =
  | MessageEvent
  | MessageDeletedEvent
  | MessageHiddenEvent
  | CallEvent;

export type MessageListener = (event: RealtimeEvent) => void;

export interface MessageBus {
  subscribe(listener: MessageListener): () => void;
  publish(event: RealtimeEvent): void;
  close(): Promise<void>;
}

/** 단일 프로세스용 버스(테스트·개발 기본). */
export class LocalMessageBus implements MessageBus {
  readonly #listeners = new Set<MessageListener>();

  subscribe(listener: MessageListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(event: RealtimeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "message_bus_listener_failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }

  async close(): Promise<void> {
    this.#listeners.clear();
  }
}

export type SerializedRealtimeEvent =
  | {
      type: "message.created";
      conversationId: string;
      message: Record<string, unknown> & { createdAt: string };
      keys: Array<Record<string, unknown> & { createdAt: string }>;
      participantUserIds: string[];
    }
  | {
      type: "message.deleted";
      conversationId: string;
      messageIds: string[];
      participantUserIds: string[];
    }
  | {
      type: "message.hidden";
      conversationId: string;
      messageIds: string[];
      userId: string;
    }
  | {
      type: "call.relay";
      conversationId: string;
      participantUserIds: string[];
      fromDeviceId: string;
      frame: CallServerFrame;
    };

export function serializeMessageEvent(event: RealtimeEvent): SerializedRealtimeEvent {
  if (event.type === "call.relay") {
    return {
      type: "call.relay",
      conversationId: event.conversationId,
      participantUserIds: event.participantUserIds,
      fromDeviceId: event.fromDeviceId,
      frame: event.frame,
    };
  }
  if (event.type === "message.deleted") {
    return {
      type: "message.deleted",
      conversationId: event.conversationId,
      messageIds: event.messageIds,
      participantUserIds: event.participantUserIds,
    };
  }
  if (event.type === "message.hidden") {
    return {
      type: "message.hidden",
      conversationId: event.conversationId,
      messageIds: event.messageIds,
      userId: event.userId,
    };
  }
  return {
    type: "message.created",
    conversationId: event.conversationId,
    message: { ...event.message, createdAt: event.message.createdAt.toISOString() },
    keys: event.keys.map((key) => ({
      ...key,
      createdAt: key.createdAt.toISOString(),
    })),
    participantUserIds: event.participantUserIds,
  };
}

export function deserializeMessageEvent(data: SerializedRealtimeEvent): RealtimeEvent {
  if (data.type === "call.relay") {
    return {
      type: "call.relay",
      conversationId: data.conversationId,
      participantUserIds: data.participantUserIds,
      fromDeviceId: data.fromDeviceId,
      frame: data.frame,
    };
  }
  if (data.type === "message.deleted") {
    return {
      type: "message.deleted",
      conversationId: data.conversationId,
      messageIds: data.messageIds,
      participantUserIds: data.participantUserIds,
    };
  }
  if (data.type === "message.hidden") {
    return {
      type: "message.hidden",
      conversationId: data.conversationId,
      messageIds: data.messageIds,
      userId: data.userId,
    };
  }
  return {
    type: "message.created",
    conversationId: data.conversationId,
    message: {
      ...data.message,
      createdAt: new Date(data.message.createdAt),
    } as MessageRow,
    keys: data.keys.map(
      (key) =>
        ({
          ...key,
          createdAt: new Date(key.createdAt),
        }) as MessageKeyRow,
    ),
    participantUserIds: data.participantUserIds,
  };
}

type RedisClient = ReturnType<typeof createClient>;

/**
 * Redis/Dragonfly pub/sub 팬아웃.
 * 같은 인스턴스의 publish 는 로컬에서 즉시 전달하고, 다른 인스턴스에는 Redis 로 전파한다.
 * Redis 장애 시에도 단일 인스턴스 동작은 유지된다.
 */
export class RedisMessageBus implements MessageBus {
  readonly #instanceId = randomUUID();
  readonly #local = new LocalMessageBus();

  private constructor(
    private readonly channel: string,
    private readonly publisher: RedisClient,
    private readonly subscriber: RedisClient,
  ) {}

  static async create(url: string, channel: string): Promise<RedisMessageBus> {
    const publisher = createClient({ url });
    const subscriber = createClient({ url });
    const logError = (error: unknown) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "redis_error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    };
    publisher.on("error", logError);
    subscriber.on("error", logError);

    await publisher.connect();
    await subscriber.connect();

    const bus = new RedisMessageBus(channel, publisher, subscriber);
    await subscriber.subscribe(channel, (message) => bus.handle(message));
    return bus;
  }

  subscribe(listener: MessageListener): () => void {
    return this.#local.subscribe(listener);
  }

  publish(event: RealtimeEvent): void {
    // 같은 인스턴스의 연결에는 즉시 전달한다.
    this.#local.publish(event);
    const payload = JSON.stringify({
      origin: this.#instanceId,
      event: serializeMessageEvent(event),
    });
    void this.publisher.publish(this.channel, payload).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "redis_publish_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  private handle(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as {
        origin?: unknown;
        event?: SerializedRealtimeEvent;
      };
      if (parsed.origin === this.#instanceId || !parsed.event) return;
      this.#local.publish(deserializeMessageEvent(parsed.event));
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "redis_message_invalid",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async close(): Promise<void> {
    await this.#local.close();
    await Promise.allSettled([
      this.subscriber.unsubscribe(this.channel),
      this.publisher.quit(),
      this.subscriber.quit(),
    ]);
  }
}

export async function createMessageBus(config: {
  redisUrl: string | null;
  redisChannel: string;
}): Promise<MessageBus> {
  if (config.redisUrl) {
    return RedisMessageBus.create(config.redisUrl, config.redisChannel);
  }
  return new LocalMessageBus();
}
