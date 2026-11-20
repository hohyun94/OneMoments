import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import {
  createIdentity,
  encryptMessage,
  type Identity,
} from "./support/crypto.js";
import { TestClient } from "./support/http.js";

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

interface MessageView {
  id: string;
  kind: "text" | "reaction" | "edit";
  targetMessageId: string | null;
  clientMessageId: string;
  senderUserId: string;
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

async function activeDevices(
  client: TestClient,
  conversationId: string,
): Promise<ActiveDevice[]> {
  const response = await client.request(
    "GET",
    `/api/conversations/${conversationId}/devices`,
  );
  expect(response.status).toBe(200);
  return response.body.devices;
}

async function sendMessage(
  sender: Account,
  conversationId: string,
  clientMessageId: string,
  plaintext: string,
  options: { kind?: "text" | "reaction" | "edit"; targetMessageId?: string } = {},
) {
  const devices = await activeDevices(sender.client, conversationId);
  const payload = encryptMessage({
    conversationId,
    clientMessageId,
    plaintext,
    sender: sender.identity,
    recipients: devices.map((device) => ({
      deviceId: device.id,
      identityPublicKey: device.identityPublicKey,
    })),
  });
  return sender.client.request(
    "POST",
    `/api/conversations/${conversationId}/messages`,
    {
      body: {
        ...payload,
        kind: options.kind ?? "text",
        ...(options.targetMessageId
          ? { targetMessageId: options.targetMessageId }
          : {}),
      },
    },
  );
}

async function listMessages(client: TestClient, conversationId: string): Promise<MessageView[]> {
  const response = await client.request(
    "GET",
    `/api/conversations/${conversationId}/messages`,
  );
  expect(response.status).toBe(200);
  return response.body.messages;
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

describe("conversation UX message kinds", () => {
  it("stores reply, reaction and edit metadata without plaintext", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);

    const first = await sendMessage(alice, conversationId, "m1", "hello");
    expect(first.status).toBe(201);
    const firstId = first.body.message.id as string;

    const reply = await sendMessage(bob, conversationId, "m2", "reply", {
      targetMessageId: firstId,
    });
    expect(reply.status).toBe(201);
    expect(reply.body.message.kind).toBe("text");
    expect(reply.body.message.targetMessageId).toBe(firstId);

    const reaction = await sendMessage(
      bob,
      conversationId,
      "m3",
      JSON.stringify({ emoji: "👍", op: "add" }),
      { kind: "reaction", targetMessageId: firstId },
    );
    expect(reaction.status).toBe(201);
    expect(reaction.body.message.kind).toBe("reaction");

    const edit = await sendMessage(alice, conversationId, "m4", "hello edited", {
      kind: "edit",
      targetMessageId: firstId,
    });
    expect(edit.status).toBe(201);
    expect(edit.body.message.kind).toBe("edit");

    const history = await listMessages(alice.client, conversationId);
    expect(history.map((message) => message.kind).sort()).toEqual([
      "edit",
      "reaction",
      "text",
      "text",
    ]);
    expect(history.find((message) => message.id === firstId)?.targetMessageId).toBeNull();
    expect(history.find((message) => message.kind === "reaction")?.targetMessageId).toBe(
      firstId,
    );
    expect(history.find((message) => message.kind === "edit")?.targetMessageId).toBe(
      firstId,
    );
  });

  it("validates targets, ownership, and kind-specific rules", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);
    const first = await sendMessage(alice, conversationId, "m1", "hello");
    const firstId = first.body.message.id as string;

    const noTarget = await sendMessage(alice, conversationId, "bad-1", "x", {
      kind: "reaction",
    });
    expect(noTarget.status).toBe(400);
    expect(noTarget.body.error.code).toBe("TARGET_REQUIRED");

    const unknownTarget = await sendMessage(
      alice,
      conversationId,
      "bad-2",
      JSON.stringify({ emoji: "👍", op: "add" }),
      { kind: "reaction", targetMessageId: randomUUID() },
    );
    expect(unknownTarget.status).toBe(400);
    expect(unknownTarget.body.error.code).toBe("INVALID_TARGET");

    const foreignEdit = await sendMessage(bob, conversationId, "bad-3", "hack", {
      kind: "edit",
      targetMessageId: firstId,
    });
    expect(foreignEdit.status).toBe(403);

    const reaction = await sendMessage(
      bob,
      conversationId,
      "r1",
      JSON.stringify({ emoji: "❤️", op: "add" }),
      { kind: "reaction", targetMessageId: firstId },
    );
    const reactionId = reaction.body.message.id as string;

    const replyToReaction = await sendMessage(alice, conversationId, "bad-4", "no", {
      targetMessageId: reactionId,
    });
    expect(replyToReaction.status).toBe(400);
    expect(replyToReaction.body.error.code).toBe("INVALID_TARGET");
  });

  it("excludes reactions and edits from unread counts and last message time", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);

    const first = await sendMessage(alice, conversationId, "m1", "hello");
    const firstId = first.body.message.id as string;
    await bob.client.request("PUT", `/api/conversations/${conversationId}/read`, {
      body: { messageId: firstId },
    });

    await sendMessage(
      bob,
      conversationId,
      "r1",
      JSON.stringify({ emoji: "👍", op: "add" }),
      { kind: "reaction", targetMessageId: firstId },
    );
    await sendMessage(bob, conversationId, "e1", "edited hello", {
      kind: "edit",
      targetMessageId: firstId,
    });

    const list = await alice.client.request("GET", "/api/conversations");
    const summary = list.body.conversations.find(
      (conversation: { id: string }) => conversation.id === conversationId,
    );
    expect(summary.unreadCount).toBe(0);
  });

  it("deletes only the sender's message, its reactions/edit events, and keeps replies", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);

    const first = await sendMessage(alice, conversationId, "m1", "hello");
    const firstId = first.body.message.id as string;
    await sendMessage(bob, conversationId, "m2", "reply", {
      targetMessageId: firstId,
    });
    const reaction = await sendMessage(
      bob,
      conversationId,
      "m3",
      JSON.stringify({ emoji: "👍", op: "add" }),
      { kind: "reaction", targetMessageId: firstId },
    );
    const reactionId = reaction.body.message.id as string;

    const foreignDelete = await bob.client.request(
      "DELETE",
      `/api/conversations/${conversationId}/messages/${firstId}`,
    );
    expect(foreignDelete.status).toBe(403);

    const noCsrf = await alice.client.request(
      "DELETE",
      `/api/conversations/${conversationId}/messages/${firstId}`,
      { csrf: false },
    );
    expect(noCsrf.status).toBe(403);

    const deleted = await alice.client.request(
      "DELETE",
      `/api/conversations/${conversationId}/messages/${firstId}`,
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.deletedMessageIds).toEqual(
      expect.arrayContaining([firstId, reactionId]),
    );

    const history = await listMessages(alice.client, conversationId);
    expect(history).toHaveLength(1);
    expect(history[0]?.kind).toBe("text");
    expect(history[0]?.targetMessageId).toBeNull();
  });

  it("hides a message only for the requesting user", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);

    const sent = await sendMessage(alice, conversationId, "m1", "secret");
    const messageId = sent.body.message.id as string;

    const hidden = await bob.client.request(
      "DELETE",
      `/api/conversations/${conversationId}/messages/${messageId}?scope=me`,
    );
    expect(hidden.status).toBe(200);
    expect(hidden.body.scope).toBe("me");

    const bobHistory = await listMessages(bob.client, conversationId);
    expect(bobHistory).toHaveLength(0);
    const aliceHistory = await listMessages(alice.client, conversationId);
    expect(aliceHistory).toHaveLength(1);

    const bobConversations = await bob.client.request("GET", "/api/conversations");
    expect(bobConversations.body.conversations[0].unreadCount).toBe(0);
    expect(bobConversations.body.conversations[0].lastMessageAt).toBeNull();

    // idempotent
    const again = await bob.client.request(
      "DELETE",
      `/api/conversations/${conversationId}/messages/${messageId}?scope=me`,
    );
    expect(again.status).toBe(200);

    // 받은 메시지는 모두에게서 삭제할 수 없다.
    const foreignDelete = await bob.client.request(
      "DELETE",
      `/api/conversations/${conversationId}/messages/${messageId}?scope=all`,
    );
    expect(foreignDelete.status).toBe(403);

    // 새 메시지는 정상적으로 보이고, 숨긴 메시지는 계속 제외된다.
    await sendMessage(alice, conversationId, "m2", "visible");
    const bobAfter = await listMessages(bob.client, conversationId);
    expect(bobAfter).toHaveLength(1);
    expect(bobAfter[0]?.clientMessageId).toBe("m2");

    const invalid = await bob.client.request(
      "DELETE",
      `/api/conversations/${conversationId}/messages/${messageId}?scope=everyone`,
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects hiding a message in a conversation the user does not belong to", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const carol = await registerAccount("carol");
    const conversationId = await createDirect(alice, bob);
    const sent = await sendMessage(alice, conversationId, "m1", "hello");

    const response = await carol.client.request(
      "DELETE",
      `/api/conversations/${conversationId}/messages/${sent.body.message.id}?scope=me`,
    );
    expect(response.status).toBe(404);
  });
});
