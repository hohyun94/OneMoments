import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { MessageKeyRow, MessageRow } from "../src/db/schema.js";
import {
  LocalMessageBus,
  createMessageBus,
  deserializeMessageEvent,
  serializeMessageEvent,
  type MessageDeletedEvent,
  type MessageEvent,
  type MessageHiddenEvent,
  type RealtimeEvent,
} from "../src/realtime/bus.js";

function event(): MessageEvent {
  const message = {
    id: randomUUID(),
    conversationId: randomUUID(),
    senderUserId: randomUUID(),
    senderDeviceId: randomUUID(),
    senderSigningPublicKey: "c2lnbmluZw==",
    ciphertext: "Y2lwaGVy",
    nonce: "bm9uY2U=",
    signature: "c2ln",
    clientMessageId: "m-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  } as MessageRow;

  const key = {
    messageId: message.id,
    recipientDeviceId: randomUUID(),
    ephemeralPublicKey: "ZXBo",
    wrappedKey: "d3JhcHBlZA==",
    wrapNonce: "bm9uY2U=",
    version: 1,
    createdAt: new Date("2026-01-01T00:00:01.000Z"),
  } as MessageKeyRow;

  return {
    type: "message.created",
    conversationId: message.conversationId,
    message,
    keys: [key],
    participantUserIds: ["user-a", "user-b"],
  };
}

describe("message bus", () => {
  it("round-trips dates through serialization", () => {
    const original = event();
    const restored = deserializeMessageEvent(serializeMessageEvent(original));
    if (restored.type !== "message.created") throw new Error("expected created event");
    expect(restored.message.createdAt).toBeInstanceOf(Date);
    expect(restored.message.createdAt.toISOString()).toBe(
      original.message.createdAt.toISOString(),
    );
    expect(restored.keys[0]?.createdAt).toBeInstanceOf(Date);
    expect(restored.participantUserIds).toEqual(original.participantUserIds);
  });

  it("round-trips deleted events", () => {
    const original: MessageDeletedEvent = {
      type: "message.deleted",
      conversationId: randomUUID(),
      messageIds: [randomUUID(), randomUUID()],
      participantUserIds: ["user-a", "user-b"],
    };
    const restored = deserializeMessageEvent(serializeMessageEvent(original));
    expect(restored).toEqual(original);
  });

  it("round-trips hidden events", () => {
    const original: MessageHiddenEvent = {
      type: "message.hidden",
      conversationId: randomUUID(),
      messageIds: [randomUUID()],
      userId: randomUUID(),
    };
    const restored = deserializeMessageEvent(serializeMessageEvent(original));
    expect(restored).toEqual(original);
  });

  it("delivers locally and unsubscribes", async () => {
    const bus = new LocalMessageBus();
    const received: RealtimeEvent[] = [];
    const unsubscribe = bus.subscribe((item) => received.push(item));
    bus.publish(event());
    expect(received).toHaveLength(1);
    unsubscribe();
    bus.publish(event());
    expect(received).toHaveLength(1);
    await bus.close();
  });

  it.skipIf(!process.env.REDIS_URL)(
    "fans out between instances through Redis",
    async () => {
      const redisUrl = process.env.REDIS_URL as string;
      const redisChannel = `test:${randomUUID()}`;
      const first = await createMessageBus({ redisUrl, redisChannel });
      const second = await createMessageBus({ redisUrl, redisChannel });
      try {
        const received = new Promise<RealtimeEvent>((resolve) => {
          second.subscribe((item) => resolve(item));
        });
        first.publish(event());
        const delivered = await received;
        if (delivered.type !== "message.created") throw new Error("expected created event");
        expect(delivered.message.createdAt).toBeInstanceOf(Date);
        expect(delivered.keys).toHaveLength(1);
      } finally {
        await first.close();
        await second.close();
      }
    },
  );
});
