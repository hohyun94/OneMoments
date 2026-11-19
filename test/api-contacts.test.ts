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

async function sendMessage(
  sender: Account,
  conversationId: string,
  clientMessageId: string,
  plaintext: string,
) {
  const devicesResponse = await sender.client.request(
    "GET",
    `/api/conversations/${conversationId}/devices`,
  );
  expect(devicesResponse.status).toBe(200);
  const devices = devicesResponse.body.devices as ActiveDevice[];
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
    { body: { ...payload, kind: "text" } },
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

describe("profile status message", () => {
  it("stores a trimmed status and exposes it to contacts", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    await createDirect(alice, bob);

    const updated = await alice.client.request("PUT", "/api/auth/profile", {
      body: { statusMessage: "  coffee & code  " },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.user.statusMessage).toBe("coffee & code");

    const me = await alice.client.request("GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.statusMessage).toBe("coffee & code");

    const bobConversations = await bob.client.request("GET", "/api/conversations");
    expect(bobConversations.status).toBe(200);
    expect(bobConversations.body.conversations[0].peer.statusMessage).toBe(
      "coffee & code",
    );

    const bobContacts = await bob.client.request("GET", "/api/contacts");
    expect(bobContacts.status).toBe(200);
    expect(bobContacts.body.contacts[0].statusMessage).toBe("coffee & code");
  });

  it("clears with null and rejects messages longer than 80 characters", async () => {
    const alice = await registerAccount("alice");

    const tooLong = await alice.client.request("PUT", "/api/auth/profile", {
      body: { statusMessage: "x".repeat(81) },
    });
    expect(tooLong.status).toBe(400);

    const cleared = await alice.client.request("PUT", "/api/auth/profile", {
      body: { statusMessage: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.user.statusMessage).toBeNull();

    const blank = await alice.client.request("PUT", "/api/auth/profile", {
      body: { statusMessage: "   " },
    });
    expect(blank.status).toBe(200);
    expect(blank.body.user.statusMessage).toBeNull();
  });
});

describe("contacts: favorites and blocking", () => {
  it("favorites a contact and sorts the direct conversation first", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const carol = await registerAccount("carol");
    const bobConversation = await createDirect(alice, bob);
    await createDirect(alice, carol);

    const contacts = await alice.client.request("GET", "/api/contacts");
    expect(contacts.status).toBe(200);
    expect(contacts.body.contacts).toHaveLength(2);

    const favorite = await alice.client.request(
      "PUT",
      `/api/contacts/${bob.userId}/favorite`,
      { body: { favorite: true } },
    );
    expect(favorite.status).toBe(200);

    const conversations = await alice.client.request("GET", "/api/conversations");
    expect(conversations.status).toBe(200);
    const bobSummary = conversations.body.conversations.find(
      (conversation: { id: string }) => conversation.id === bobConversation,
    );
    expect(bobSummary.favorite).toBe(true);
    expect(conversations.body.conversations[0].id).toBe(bobConversation);

    const unfavorite = await alice.client.request(
      "PUT",
      `/api/contacts/${bob.userId}/favorite`,
      { body: { favorite: false } },
    );
    expect(unfavorite.status).toBe(200);
    const after = await alice.client.request("GET", "/api/contacts");
    expect(
      after.body.contacts.find(
        (contact: { id: string }) => contact.id === bob.userId,
      ).favorite,
    ).toBe(false);
  });

  it("blocks messaging both ways until unblocked", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createDirect(alice, bob);

    const blocked = await alice.client.request(
      "PUT",
      `/api/contacts/${bob.userId}/block`,
      { body: { blocked: true } },
    );
    expect(blocked.status).toBe(200);

    const aliceContacts = await alice.client.request("GET", "/api/contacts");
    expect(aliceContacts.body.contacts[0].blockedByMe).toBe(true);
    const bobContacts = await bob.client.request("GET", "/api/contacts");
    expect(bobContacts.body.contacts[0].blockedMe).toBe(true);

    const aliceConversations = await alice.client.request("GET", "/api/conversations");
    expect(aliceConversations.body.conversations[0].blocked).toBe("me");
    const bobConversations = await bob.client.request("GET", "/api/conversations");
    expect(bobConversations.body.conversations[0].blocked).toBe("peer");

    const aliceSend = await sendMessage(alice, conversationId, randomUUID(), "hello");
    expect(aliceSend.status).toBe(403);
    expect(aliceSend.body.error.code).toBe("USER_BLOCKED");
    const bobSend = await sendMessage(bob, conversationId, randomUUID(), "hello");
    expect(bobSend.status).toBe(403);
    expect(bobSend.body.error.code).toBe("USER_BLOCKED");

    const reopen = await bob.client.request("POST", "/api/conversations", {
      body: { peerUserId: alice.userId },
    });
    expect(reopen.status).toBe(403);

    const unblocked = await alice.client.request(
      "PUT",
      `/api/contacts/${bob.userId}/block`,
      { body: { blocked: false } },
    );
    expect(unblocked.status).toBe(200);
    const sent = await sendMessage(alice, conversationId, randomUUID(), "hello again");
    expect(sent.status).toBe(201);
  });

  it("rejects self and non-contact targets", async () => {
    const alice = await registerAccount("alice");
    const stranger = await registerAccount("stranger");

    const self = await alice.client.request(
      "PUT",
      `/api/contacts/${alice.userId}/block`,
      { body: { blocked: true } },
    );
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe("INVALID_CONTACT");

    const unknown = await alice.client.request(
      "PUT",
      `/api/contacts/${stranger.userId}/favorite`,
      { body: { favorite: true } },
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("CONTACT_NOT_FOUND");
  });
});
