import { randomBytes, randomUUID } from "node:crypto";

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

function recipients(devices: ActiveDevice[]) {
  return devices.map((device) => ({
    deviceId: device.id,
    identityPublicKey: device.identityPublicKey,
  }));
}

async function sendMessage(
  sender: Account,
  conversationId: string,
  devices: ActiveDevice[],
  clientMessageId: string,
  plaintext: string,
) {
  const payload = encryptMessage({
    conversationId,
    clientMessageId,
    plaintext,
    sender: sender.identity,
    recipients: recipients(devices),
  });
  return sender.client.request(
    "POST",
    `/api/conversations/${conversationId}/messages`,
    { body: payload },
  );
}

function b64(bytes: number): string {
  return randomBytes(bytes).toString("base64");
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

describe("encrypted direct messages", () => {
  it("relays ciphertext and lets only the recipient decrypt it", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const devices = await activeDevices(alice.client, conversationId);
    expect(devices).toHaveLength(2);

    const plaintext = "안녕하세요, OneMoments!";
    const sent = await sendMessage(alice, conversationId, devices, "msg-1", plaintext);
    expect(sent.status).toBe(201);
    expect(sent.body.created).toBe(true);
    expect(sent.body.message.key.deviceId).toBe(alice.deviceId);
    expect(sent.text.includes(plaintext)).toBe(false);

    const history = await bob.client.request(
      "GET",
      `/api/conversations/${conversationId}/messages`,
    );
    expect(history.status).toBe(200);
    expect(history.body.messages).toHaveLength(1);
    const message = history.body.messages[0];
    expect(message.key.deviceId).toBe(bob.deviceId);
    expect(
      decryptMessage({
        identity: bob.identity,
        senderSigningPublicKey: alice.identity.signing.publicKeyBase64,
        message,
      }),
    ).toBe(plaintext);
    expect(history.text.includes(plaintext)).toBe(false);

    const resent = await sendMessage(alice, conversationId, devices, "msg-1", plaintext);
    expect(resent.status).toBe(200);
    expect(resent.body.created).toBe(false);
    expect(resent.body.message.id).toBe(sent.body.message.id);

    const after = await bob.client.request(
      "GET",
      `/api/conversations/${conversationId}/messages`,
    );
    expect(after.body.messages).toHaveLength(1);
  });

  it("rejects a message that omits an active device", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const devices = await activeDevices(alice.client, conversationId);

    const incomplete = devices.filter((device) => device.id !== alice.deviceId);
    const response = await sendMessage(
      alice,
      conversationId,
      incomplete,
      "missing-self",
      "hello",
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("DEVICE_SET_CHANGED");
    expect(response.body.error.details.devices).toHaveLength(2);
    expect(
      response.body.error.details.devices.map((device: ActiveDevice) => device.id).sort(),
    ).toEqual(devices.map((device) => device.id).sort());

    const correct = await sendMessage(alice, conversationId, devices, "complete", "hello");
    expect(correct.status).toBe(201);
  });

  it("hides conversations and keys from non-participants", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const carol = await registerAccount("carol");
    const conversationId = await createConversation(alice, bob);
    const devices = await activeDevices(alice.client, conversationId);
    await sendMessage(alice, conversationId, devices, "msg-1", "secret");

    const read = await carol.client.request(
      "GET",
      `/api/conversations/${conversationId}/messages`,
    );
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe("CONVERSATION_NOT_FOUND");

    const write = await carol.client.request(
      "POST",
      `/api/conversations/${conversationId}/messages`,
      {
        body: encryptMessage({
          conversationId,
          clientMessageId: "intruder",
          plaintext: "not allowed",
          sender: carol.identity,
          recipients: recipients(devices),
        }),
      },
    );
    expect(write.status).toBe(404);

    const devicesRead = await carol.client.request(
      "GET",
      `/api/conversations/${conversationId}/devices`,
    );
    expect(devicesRead.status).toBe(404);

    const self = await alice.client.request("POST", "/api/conversations", {
      body: { peerUserId: alice.userId },
    });
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe("CANNOT_MESSAGE_SELF");
  });

  it("pageinates message history newest-first", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const devices = await activeDevices(alice.client, conversationId);

    for (let index = 0; index < 3; index += 1) {
      const sent = await sendMessage(
        alice,
        conversationId,
        devices,
        `page-${index}`,
        `message-${index}`,
      );
      expect(sent.status).toBe(201);
    }

    const firstPage = await bob.client.request(
      "GET",
      `/api/conversations/${conversationId}/messages?limit=2`,
    );
    expect(firstPage.body.messages).toHaveLength(2);
    expect(firstPage.body.nextCursor).toBe(firstPage.body.messages[1].id);

    const secondPage = await bob.client.request(
      "GET",
      `/api/conversations/${conversationId}/messages?limit=2&before=${firstPage.body.nextCursor}`,
    );
    expect(secondPage.body.messages).toHaveLength(1);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it("supports multiple devices and isolates history per device", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const devices = await activeDevices(alice.client, conversationId);
    expect(devices).toHaveLength(2);

    const before = await sendMessage(alice, conversationId, devices, "before", "before device");
    expect(before.status).toBe(201);

    const laptopIdentity = createIdentity();
    const added = await bob.client.addDevice("laptop", laptopIdentity);
    expect(added.status).toBe(201);
    const laptopDeviceId = added.body.device.id as string;

    const devicesAfter = await activeDevices(alice.client, conversationId);
    expect(devicesAfter).toHaveLength(3);

    // 새 기기를 모르는 상태의 봉투는 거절된다.
    const stale = await sendMessage(alice, conversationId, devices, "after-stale", "stale");
    expect(stale.status).toBe(409);

    const after = await sendMessage(
      alice,
      conversationId,
      devicesAfter,
      "after",
      "after device",
    );
    expect(after.status).toBe(201);

    const laptopClient = new TestClient(ctx.baseUrl);
    const laptopLogin = await laptopClient.request("POST", "/api/auth/login", {
      body: {
        username: bob.username,
        password: "password-12345",
        deviceId: laptopDeviceId,
      },
    });
    expect(laptopLogin.status).toBe(200);

    const laptopHistory = await laptopClient.request(
      "GET",
      `/api/conversations/${conversationId}/messages`,
    );
    // 새 기기는 등록 이후 메시지만 받는다.
    expect(laptopHistory.body.messages).toHaveLength(1);
    expect(
      decryptMessage({
        identity: laptopIdentity,
        senderSigningPublicKey: alice.identity.signing.publicKeyBase64,
        message: laptopHistory.body.messages[0],
      }),
    ).toBe("after device");

    const bobHistory = await bob.client.request(
      "GET",
      `/api/conversations/${conversationId}/messages`,
    );
    expect(bobHistory.body.messages).toHaveLength(2);
    expect(
      decryptMessage({
        identity: bob.identity,
        senderSigningPublicKey: alice.identity.signing.publicKeyBase64,
        message: bobHistory.body.messages[0],
      }),
    ).toBe("after device");
  });

  it("hides a conversation for one user only", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const devices = await activeDevices(alice.client, conversationId);
    await sendMessage(alice, conversationId, devices, "msg-1", "hello");

    const hidden = await alice.client.request(
      "DELETE",
      `/api/conversations/${conversationId}`,
    );
    expect(hidden.status).toBe(204);

    const aliceList = await alice.client.request("GET", "/api/conversations");
    expect(aliceList.body.conversations).toHaveLength(0);
    const bobList = await bob.client.request("GET", "/api/conversations");
    expect(bobList.body.conversations).toHaveLength(1);

    // 같은 상대와 다시 시작하면 기존 대화가 다시 보인다.
    const again = await alice.client.request("POST", "/api/conversations", {
      body: { peerUserId: bob.userId },
    });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.conversation.id).toBe(conversationId);
    const relisted = await alice.client.request("GET", "/api/conversations");
    expect(relisted.body.conversations).toHaveLength(1);
  });

  it("rejects malformed envelopes before storage", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const devices = await activeDevices(alice.client, conversationId);

    const valid = encryptMessage({
      conversationId,
      clientMessageId: "valid",
      plaintext: "hello",
      sender: alice.identity,
      recipients: recipients(devices),
    });
    const post = (body: unknown) =>
      alice.client.request("POST", `/api/conversations/${conversationId}/messages`, {
        body,
      });

    const oversized = await post({
      ...valid,
      clientMessageId: "oversized",
      ciphertext: randomBytes(20_000).toString("base64"),
    });
    expect(oversized.status).toBe(413);

    expect((await post({ ...valid, clientMessageId: "bad-nonce", nonce: b64(8) })).status).toBe(400);
    expect(
      (await post({ ...valid, clientMessageId: "bad-sig", signature: b64(32) })).status,
    ).toBe(400);

    const duplicateKey = valid.keys[0];
    if (!duplicateKey) throw new Error("missing key");
    const duplicate = await post({
      ...valid,
      clientMessageId: "duplicate",
      keys: [duplicateKey, duplicateKey],
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.code).toBe("DUPLICATE_DEVICE_KEY");

    const version = await post({
      ...valid,
      clientMessageId: "version",
      keys: valid.keys.map((key) => ({ ...key, version: 2 })),
    });
    expect(version.status).toBe(400);
    expect(version.body.error.code).toBe("UNSUPPORTED_ENVELOPE_VERSION");

    const history = await bob.client.request(
      "GET",
      `/api/conversations/${conversationId}/messages`,
    );
    expect(history.body.messages).toHaveLength(0);
  });
});

describe("operational endpoints", () => {
  it("serves health checks and safe error shapes", async () => {
    const health = await new TestClient(ctx.baseUrl).request("GET", "/healthz");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: "ok", service: "onemoments" });

    const ready = await new TestClient(ctx.baseUrl).request("GET", "/readyz");
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe("ready");

    const invalidJson = await new TestClient(ctx.baseUrl).request(
      "POST",
      "/api/auth/login",
      { rawBody: "{oops" },
    );
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.body.error.code).toBe("INVALID_JSON");

    const unauthorized = await new TestClient(ctx.baseUrl).request(
      "GET",
      "/api/conversations",
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.error.code).toBe("UNAUTHORIZED");

    const missing = await new TestClient(ctx.baseUrl).request("GET", "/api/nope");
    expect(missing.status).toBe(404);

    const metricsDenied = await new TestClient(ctx.baseUrl).request("GET", "/metrics");
    expect(metricsDenied.status).toBe(401);

    const metrics = await new TestClient(ctx.baseUrl).request("GET", "/metrics", {
      headers: { authorization: `Bearer ${ctx.config.metricsToken}` },
    });
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain("onemoments_messages_total");
    expect(metrics.text).toContain("onemoments_ws_connections");
    expect(metrics.text).toContain("onemoments_db_ready 1");
  });
});
