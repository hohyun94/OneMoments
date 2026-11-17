import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import {
  createIdentity,
  encryptMessage,
  type Identity,
} from "./support/crypto.js";
import { TestClient } from "./support/http.js";
import {
  attachments,
  conversationParticipants,
  conversationReads,
  messageKeys,
  messages,
  messageReads,
} from "../src/db/schema.js";
import { cleanupAutoDeletedMessages } from "../src/services/autoDelete.js";
import { createAttachmentStorage } from "../src/services/attachments.js";

interface Account {
  client: TestClient;
  identity: Identity;
  userId: string;
  deviceId: string;
  username: string;
}

interface ActiveDevice {
  id: string;
  userId: string;
  identityPublicKey: string;
  signingPublicKey: string;
}

let ctx: TestContext;

async function registerAccount(prefix: string): Promise<Account> {
  const client = new TestClient(ctx.baseUrl);
  const identity = createIdentity();
  const username = `${prefix}${randomUUID().slice(0, 8)}`;
  const response = await client.register(username, identity);
  expect(response.status).toBe(201);
  return {
    client,
    identity,
    userId: response.body.user.id,
    deviceId: response.body.device.id,
    username,
  };
}

async function createDirect(initiator: Account, peer: Account): Promise<string> {
  const response = await initiator.client.request("POST", "/api/conversations", {
    body: { peerUserId: peer.userId },
  });
  expect(response.status).toBe(201);
  return response.body.conversation.id;
}

async function createGroup(
  creator: Account,
  name: string,
  members: Account[],
): Promise<string> {
  const response = await creator.client.request("POST", "/api/conversations", {
    body: {
      kind: "group",
      name,
      memberUserIds: members.map((member) => member.userId),
    },
  });
  expect(response.status).toBe(201);
  return response.body.conversation.id;
}

async function sendMessage(
  sender: Account,
  conversationId: string,
  clientMessageId: string,
): Promise<string> {
  const devicesResponse = await sender.client.request(
    "GET",
    `/api/conversations/${conversationId}/devices`,
  );
  expect(devicesResponse.status).toBe(200);
  const devices = devicesResponse.body.devices as ActiveDevice[];
  const payload = encryptMessage({
    conversationId,
    clientMessageId,
    plaintext: `hello ${clientMessageId}`,
    sender: sender.identity,
    recipients: devices.map((device) => ({
      deviceId: device.id,
      identityPublicKey: device.identityPublicKey,
    })),
  });
  const response = await sender.client.request(
    "POST",
    `/api/conversations/${conversationId}/messages`,
    { body: payload },
  );
  expect(response.status).toBe(201);
  return response.body.message.id as string;
}

async function markRead(client: TestClient, conversationId: string, messageId: string) {
  const response = await client.request("PUT", `/api/conversations/${conversationId}/read`, {
    body: { messageId },
  });
  expect(response.status).toBe(200);
}

async function setAutoDelete(
  client: TestClient,
  conversationId: string,
  seconds: number | null,
) {
  return client.request("PUT", `/api/conversations/${conversationId}/auto-delete`, {
    body: { seconds },
  });
}

async function countMessages(conversationId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(sql`${messages.conversationId} = ${conversationId}`);
  return row?.count ?? 0;
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.db);
});

describe("conversation auto delete settings", () => {
  it("stores the option on the conversation and exposes it in summaries", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);

    const updated = await setAutoDelete(alice.client, conversationId, 7 * 24 * 60 * 60);
    expect(updated.status).toBe(200);
    expect(updated.body.conversation.autoDeleteAfterReadSeconds).toBe(604_800);

    const list = await bob.client.request("GET", "/api/conversations");
    expect(list.status).toBe(200);
    const summary = list.body.conversations.find(
      (conversation: { id: string }) => conversation.id === conversationId,
    );
    expect(summary.autoDeleteAfterReadSeconds).toBe(604_800);

    const cleared = await setAutoDelete(bob.client, conversationId, null);
    expect(cleared.status).toBe(200);
    expect(cleared.body.conversation.autoDeleteAfterReadSeconds).toBeNull();
  });

  it("validates the range and requires CSRF", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);

    expect((await setAutoDelete(alice.client, conversationId, 3_599)).status).toBe(400);
    expect((await setAutoDelete(alice.client, conversationId, 31 * 24 * 60 * 60)).status).toBe(
      400,
    );

    const noCsrf = await alice.client.request(
      "PUT",
      `/api/conversations/${conversationId}/auto-delete`,
      { body: { seconds: 86_400 }, csrf: false },
    );
    expect(noCsrf.status).toBe(403);
  });

  it("lets only the group owner change the group setting", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const carol = await registerAccount("carol");
    const conversationId = await createGroup(alice, "family", [bob, carol]);

    const denied = await setAutoDelete(bob.client, conversationId, 86_400);
    expect(denied.status).toBe(403);

    const allowed = await setAutoDelete(alice.client, conversationId, 86_400);
    expect(allowed.status).toBe(200);
    expect(allowed.body.conversation.autoDeleteAfterReadSeconds).toBe(86_400);
  });
});

describe("message read timestamps", () => {
  it("records a per-message read time for the reader only", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);
    const messageId = await sendMessage(alice, conversationId, "msg-1");

    await markRead(bob.client, conversationId, messageId);

    const rows = await ctx.db.select().from(messageReads);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.messageId).toBe(messageId);
    expect(rows[0]?.userId).toBe(bob.userId);
    expect(rows[0]?.readAt).toBeInstanceOf(Date);
  });

  it("does not duplicate read rows when the cursor advances again", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);
    await sendMessage(alice, conversationId, "msg-1");
    const secondId = await sendMessage(alice, conversationId, "msg-2");

    await markRead(bob.client, conversationId, secondId);
    await markRead(bob.client, conversationId, secondId);

    const rows = await ctx.db.select().from(messageReads);
    expect(rows).toHaveLength(2);
  });
});

describe("auto delete cleanup", () => {
  it("deletes messages, envelopes and read cursors once everyone has read", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);
    await setAutoDelete(alice.client, conversationId, 3_600);
    const messageId = await sendMessage(alice, conversationId, "msg-1");
    await markRead(bob.client, conversationId, messageId);

    const storage = createAttachmentStorage(ctx.config);
    const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const result = await cleanupAutoDeletedMessages(ctx.db, storage, { now });

    expect(result.deletedMessages).toBe(1);
    expect(await countMessages(conversationId)).toBe(0);
    expect(await ctx.db.select().from(messageKeys)).toHaveLength(0);
    expect(await ctx.db.select().from(conversationReads)).toHaveLength(0);
  });

  it("keeps messages until every participant has read them", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);
    await setAutoDelete(alice.client, conversationId, 3_600);
    const messageId = await sendMessage(alice, conversationId, "msg-1");

    const storage = createAttachmentStorage(ctx.config);
    const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect((await cleanupAutoDeletedMessages(ctx.db, storage, { now })).deletedMessages).toBe(
      0,
    );
    expect(await countMessages(conversationId)).toBe(1);

    await markRead(bob.client, conversationId, messageId);
    expect((await cleanupAutoDeletedMessages(ctx.db, storage, { now })).deletedMessages).toBe(
      1,
    );
    expect(await countMessages(conversationId)).toBe(0);
  });

  it("requires every group recipient but ignores members who joined later", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const carol = await registerAccount("carol");
    const dave = await registerAccount("dave");
    const conversationId = await createGroup(alice, "trips", [bob, carol]);
    await setAutoDelete(alice.client, conversationId, 3_600);
    const messageId = await sendMessage(alice, conversationId, "msg-1");

    const storage = createAttachmentStorage(ctx.config);
    const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await markRead(bob.client, conversationId, messageId);
    expect((await cleanupAutoDeletedMessages(ctx.db, storage, { now })).deletedMessages).toBe(
      0,
    );

    await markRead(carol.client, conversationId, messageId);
    // 메시지 이후에 참여한 dave 는 읽음 대상이 아니므로 삭제를 막지 않는다.
    await ctx.db.insert(conversationParticipants).values({
      conversationId,
      userId: dave.userId,
      joinedAt: new Date(Date.now() + 60 * 60 * 1000),
      role: "member",
    });

    expect((await cleanupAutoDeletedMessages(ctx.db, storage, { now })).deletedMessages).toBe(
      1,
    );
    expect(await countMessages(conversationId)).toBe(0);
  });

  it("deletes attachment rows and blobs with the message", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);
    await setAutoDelete(alice.client, conversationId, 3_600);
    const messageId = await sendMessage(alice, conversationId, "msg-1");
    await markRead(bob.client, conversationId, messageId);

    const storage = createAttachmentStorage(ctx.config);
    const attachmentId = randomUUID();
    await storage.put(attachmentId, Buffer.from("ciphertext"));
    await ctx.db.insert(attachments).values({
      id: attachmentId,
      conversationId,
      uploaderUserId: alice.userId,
      size: 10,
      messageClientId: "msg-1",
      messageId,
    });

    const result = await cleanupAutoDeletedMessages(ctx.db, storage, {
      now: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });
    expect(result.deletedAttachments).toBe(1);
    expect(await ctx.db.select().from(attachments)).toHaveLength(0);
    await expect(storage.get(attachmentId)).rejects.toBeTruthy();
  });

  it("cleans up lazily when the message list is fetched", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);
    await setAutoDelete(alice.client, conversationId, 3_600);
    const messageId = await sendMessage(alice, conversationId, "msg-1");
    await markRead(bob.client, conversationId, messageId);

    // 기능 도입 이전처럼 보이도록 생성/읽은 시각을 과거로 옮긴다.
    await ctx.db.execute(
      sql`update ${messages} set created_at = now() - interval '3 hours' where id = ${messageId}`,
    );
    await ctx.db.execute(
      sql`update ${messageReads} set read_at = now() - interval '2 hours' where message_id = ${messageId}`,
    );

    const list = await bob.client.request(
      "GET",
      `/api/conversations/${conversationId}/messages`,
    );
    expect(list.status).toBe(200);
    expect(list.body.messages).toHaveLength(0);
    expect(await countMessages(conversationId)).toBe(0);
  });

  it("does nothing when the option is off", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);
    const messageId = await sendMessage(alice, conversationId, "msg-1");
    await markRead(bob.client, conversationId, messageId);

    const storage = createAttachmentStorage(ctx.config);
    const result = await cleanupAutoDeletedMessages(ctx.db, storage, {
      now: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
    expect(result.deletedMessages).toBe(0);
    expect(await countMessages(conversationId)).toBe(1);
  });
});
