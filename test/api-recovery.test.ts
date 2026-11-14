import { randomUUID, sign } from "node:crypto";

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

function recoverSignature(identity: Identity, challenge: string): string {
  return sign(
    null,
    Buffer.from(`recover:${challenge}`, "utf8"),
    identity.signing.privateKey,
  ).toString("base64");
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

describe("key backup and device recovery", () => {
  it("recovers a device and keeps access to existing history", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const devices = await activeDevices(alice.client, conversationId);

    const plaintext = "복구 전에 보낸 메시지";
    const envelope = encryptMessage({
      conversationId,
      clientMessageId: "before-recovery",
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

    const blob = JSON.stringify({ version: 1, ciphertext: "opaque-backup" });
    const saved = await alice.client.request("PUT", "/api/auth/backup", {
      body: { blob },
    });
    expect(saved.status).toBe(200);

    const own = await alice.client.request("GET", "/api/auth/backup");
    expect(own.status).toBe(200);
    expect(own.body.backup.blob).toBe(blob);

    const lookup = await new TestClient(ctx.baseUrl).request(
      "POST",
      "/api/auth/recovery/lookup",
      { body: { username: alice.username } },
    );
    expect(lookup.status).toBe(200);
    expect(lookup.body.backup.blob).toBe(blob);

    const recoverer = new TestClient(ctx.baseUrl);
    const challengeResponse = await recoverer.request(
      "POST",
      "/api/auth/recovery/challenge",
      { body: { deviceId: alice.deviceId } },
    );
    expect(challengeResponse.status).toBe(200);
    const challengeId = challengeResponse.body.challengeId as string;
    const challenge = challengeResponse.body.challenge as string;

    const recovered = await recoverer.request("POST", "/api/auth/recover", {
      body: {
        deviceId: alice.deviceId,
        challengeId,
        signature: recoverSignature(alice.identity, challenge),
      },
    });
    expect(recovered.status).toBe(200);
    expect(recovered.body.user.id).toBe(alice.userId);
    expect(recovered.body.device.id).toBe(alice.deviceId);

    expect((await alice.client.request("GET", "/api/auth/me")).status).toBe(401);
    expect((await recoverer.request("GET", "/api/auth/me")).status).toBe(200);

    const history = await recoverer.request(
      "GET",
      `/api/conversations/${conversationId}/messages`,
    );
    expect(history.status).toBe(200);
    expect(history.body.messages).toHaveLength(1);
    expect(
      decryptMessage({
        identity: alice.identity,
        senderSigningPublicKey: alice.identity.signing.publicKeyBase64,
        message: history.body.messages[0],
      }),
    ).toBe(plaintext);

    const replay = await recoverer.request("POST", "/api/auth/recover", {
      body: {
        deviceId: alice.deviceId,
        challengeId,
        signature: recoverSignature(alice.identity, challenge),
      },
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("RECOVERY_CHALLENGE_INVALID");
  });

  it("rejects invalid signatures and revoked devices", async () => {
    const alice = await registerAccount("alice");
    const attacker = new TestClient(ctx.baseUrl);

    const challengeResponse = await attacker.request(
      "POST",
      "/api/auth/recovery/challenge",
      { body: { deviceId: alice.deviceId } },
    );
    expect(challengeResponse.status).toBe(200);

    const invalid = await attacker.request("POST", "/api/auth/recover", {
      body: {
        deviceId: alice.deviceId,
        challengeId: challengeResponse.body.challengeId,
        signature: recoverSignature(alice.identity, "wrong-message"),
      },
    });
    expect(invalid.status).toBe(401);

    const revoked = await alice.client.request(
      "DELETE",
      `/api/devices/${alice.deviceId}`,
    );
    expect(revoked.status).toBe(200);

    const unavailable = await attacker.request(
      "POST",
      "/api/auth/recovery/challenge",
      { body: { deviceId: alice.deviceId } },
    );
    expect(unavailable.status).toBe(404);
    expect(unavailable.body.error.code).toBe("RECOVERY_UNAVAILABLE");
  });

  it("enforces backup size and requires a session", async () => {
    const alice = await registerAccount("alice");

    const anonymous = new TestClient(ctx.baseUrl);
    expect((await anonymous.request("GET", "/api/auth/backup")).status).toBe(401);

    const tooLarge = await alice.client.request("PUT", "/api/auth/backup", {
      rawBody: "x".repeat(ctx.config.backupMaxBytes + 1),
      headers: { "content-type": "text/plain" },
    });
    expect(tooLarge.status).toBe(413);

    const missing = await new TestClient(ctx.baseUrl).request(
      "POST",
      "/api/auth/recovery/lookup",
      { body: { username: alice.username } },
    );
    expect(missing.status).toBe(404);

    const unknown = await new TestClient(ctx.baseUrl).request(
      "POST",
      "/api/auth/recovery/lookup",
      { body: { username: `nobody${randomUUID().slice(0, 6)}` } },
    );
    expect(unknown.status).toBe(404);
  });
});
