import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity, encryptMessage, type Identity } from "./support/crypto.js";
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
  identityPublicKey: string;
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

async function createConversation(initiator: Account, peer: Account): Promise<string> {
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
  const response = await sender.client.request(
    "POST",
    `/api/conversations/${conversationId}/messages`,
    { body: payload },
  );
  expect(response.status).toBe(201);
  return response.body.message.id as string;
}

async function setPinned(
  client: TestClient,
  conversationId: string,
  messageId: string,
  pinned: boolean,
) {
  return client.request(
    "PUT",
    `/api/conversations/${conversationId}/messages/${messageId}/pin`,
    { body: { pinned } },
  );
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

describe("message pinning", () => {
  it("lets a direct participant pin and unpin a message", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const messageId = await sendMessage(alice, conversationId, "pin-1", "고정할 메시지");

    const pinned = await setPinned(bob.client, conversationId, messageId, true);
    expect(pinned.status).toBe(200);
    expect(pinned.body.pinned).toBe(true);

    const list = await bob.client.request(
      "GET",
      `/api/conversations/${conversationId}/messages?pinned=1`,
    );
    expect(list.status).toBe(200);
    expect(list.body.messages.map((message: { id: string }) => message.id)).toEqual([
      messageId,
    ]);
    expect(list.body.messages[0].pinned).toBe(true);

    const unpinned = await setPinned(bob.client, conversationId, messageId, false);
    expect(unpinned.status).toBe(200);
    expect(unpinned.body.pinned).toBe(false);

    const after = await bob.client.request(
      "GET",
      `/api/conversations/${conversationId}/messages?pinned=1`,
    );
    expect(after.body.messages).toHaveLength(0);
  });

  it("restricts group pinning to the owner or the sender", async () => {
    const owner = await registerAccount("owner");
    const member = await registerAccount("member");
    const third = await registerAccount("third");
    const created = await owner.client.request("POST", "/api/conversations", {
      body: {
        kind: "group",
        name: "pin test",
        memberUserIds: [member.userId, third.userId],
      },
    });
    expect(created.status).toBe(201);
    const conversationId = created.body.conversation.id as string;
    const messageId = await sendMessage(member, conversationId, "group-pin", "멤버 메시지");

    // 발신자 본인은 고정할 수 있다.
    const bySender = await setPinned(member.client, conversationId, messageId, true);
    expect(bySender.status).toBe(200);
    await setPinned(member.client, conversationId, messageId, false);

    // 다른 일반 참여자는 고정할 수 없다.
    const byThird = await setPinned(third.client, conversationId, messageId, true);
    expect(byThird.status).toBe(403);

    // 그룹 소유자는 고정할 수 있다.
    const byOwner = await setPinned(owner.client, conversationId, messageId, true);
    expect(byOwner.status).toBe(200);
  });

  it("requires csrf and participant membership", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const outsider = await registerAccount("outsider");
    const conversationId = await createConversation(alice, bob);
    const messageId = await sendMessage(alice, conversationId, "pin-csrf", "보안");

    const noCsrf = await alice.client.request(
      "PUT",
      `/api/conversations/${conversationId}/messages/${messageId}/pin`,
      { body: { pinned: true }, csrf: false },
    );
    expect(noCsrf.status).toBe(403);

    const byOutsider = await setPinned(outsider.client, conversationId, messageId, true);
    expect(byOutsider.status).toBe(404);
  });
});
