import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import {
  createIdentity,
  decryptMessage,
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

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.db);
});

describe("account deletion and session rotation", () => {
  it("anonymizes the account but keeps peer history readable", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const devices = await activeDevices(alice.client, conversationId);

    const plaintext = "삭제 후에도 남는 메시지";
    const envelope = encryptMessage({
      conversationId,
      clientMessageId: "keep-1",
      plaintext,
      sender: alice.identity,
      recipients: devices.map((device) => ({
        deviceId: device.id,
        identityPublicKey: device.identityPublicKey,
      })),
    });
    const sent = await alice.client.request(
      "POST",
      `/api/conversations/${conversationId}/messages`,
      { body: envelope },
    );
    expect(sent.status).toBe(201);

    const wrong = await alice.client.request("DELETE", "/api/auth/account", {
      body: { password: "wrong-password" },
    });
    expect(wrong.status).toBe(401);
    expect((await alice.client.request("GET", "/api/auth/me")).status).toBe(200);

    const deleted = await alice.client.request("DELETE", "/api/auth/account", {
      body: { password: "password-12345" },
    });
    expect(deleted.status).toBe(204);

    expect((await alice.client.request("GET", "/api/auth/me")).status).toBe(401);
    const relogin = new TestClient(ctx.baseUrl);
    const reloginResponse = await relogin.request("POST", "/api/auth/login", {
      body: {
        username: alice.username,
        password: "password-12345",
        deviceId: alice.deviceId,
      },
    });
    expect(reloginResponse.status).toBe(401);

    const conversations = await bob.client.request("GET", "/api/conversations");
    expect(conversations.body.conversations).toHaveLength(1);
    expect(conversations.body.conversations[0].peer.deleted).toBe(true);
    expect(conversations.body.conversations[0].peer.username).toBeNull();

    const history = await bob.client.request(
      "GET",
      `/api/conversations/${conversationId}/messages`,
    );
    expect(history.body.messages).toHaveLength(1);
    expect(
      decryptMessage({
        identity: bob.identity,
        senderSigningPublicKey: alice.identity.signing.publicKeyBase64,
        message: history.body.messages[0],
      }),
    ).toBe(plaintext);

    const reply = await bob.client.request(
      "POST",
      `/api/conversations/${conversationId}/messages`,
      {
        body: encryptMessage({
          conversationId,
          clientMessageId: "reply-1",
          plaintext: "답장",
          sender: bob.identity,
          recipients: devices.map((device) => ({
            deviceId: device.id,
            identityPublicKey: device.identityPublicKey,
          })),
        }),
      },
    );
    expect(reply.status).toBe(403);
    expect(reply.body.error.code).toBe("PEER_DELETED");

    const search = await bob.client.request(
      "GET",
      `/api/users/search?username=${encodeURIComponent(alice.username)}`,
    );
    expect(search.status).toBe(200);
    expect(search.body.user).toBeNull();
  });

  it("rotates the session when logging in again on the same device", async () => {
    const alice = await registerAccount("alice");

    const second = new TestClient(ctx.baseUrl);
    const login = await second.request("POST", "/api/auth/login", {
      body: {
        username: alice.username,
        password: "password-12345",
        deviceId: alice.deviceId,
      },
    });
    expect(login.status).toBe(200);

    // 같은 기기의 이전 세션은 폐기된다.
    expect((await alice.client.request("GET", "/api/auth/me")).status).toBe(401);
    expect((await second.request("GET", "/api/auth/me")).status).toBe(200);
  });
});
