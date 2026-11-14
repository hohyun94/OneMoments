import { randomBytes, randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { hashPassword } from "../src/auth/password.js";
import { loginProfiles, users } from "../src/db/schema.js";
import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";

let ctx: TestContext;

async function registerAccount(prefix: string) {
  const client = new TestClient(ctx.baseUrl);
  const identity = createIdentity();
  const username = `${prefix}${randomUUID().slice(0, 8)}`;
  const response = await client.register(username, identity);
  expect(response.status).toBe(201);
  return {
    client,
    identity,
    username,
    userId: response.body.user.id as string,
    deviceId: response.body.device.id as string,
  };
}

describe("decoy profile login", () => {
  beforeEach(async () => {
    ctx = await createTestContext();
    await resetDatabase(ctx.db);
  });

  it("routes the decoy password to an isolated profile", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const created = await alice.client.request("POST", "/api/conversations", {
      body: { peerUserId: bob.userId },
    });
    expect(created.status).toBe(201);
    const realConversationId = created.body.conversation.id as string;

    const decoyPassword = `decoy-${randomBytes(12).toString("base64url")}`;
    const decoyUsername = `decoy_${randomUUID().slice(0, 8)}`;
    const [decoyUser] = await ctx.db
      .insert(users)
      .values({
        username: decoyUsername,
        passwordHash: await hashPassword(randomBytes(32).toString("base64url")),
      })
      .returning();
    if (!decoyUser) throw new Error("missing decoy user");
    await ctx.db.insert(loginProfiles).values({
      alias: alice.username,
      userId: decoyUser.id,
      passwordHash: await hashPassword(decoyPassword),
      kind: "decoy",
    });

    const realLogin = await new TestClient(ctx.baseUrl).request("POST", "/api/auth/login", {
      body: { username: alice.username, password: "password-12345", deviceId: alice.deviceId },
    });
    expect(realLogin.status).toBe(200);
    expect(realLogin.body.user.id).toBe(alice.userId);

    const decoy = new TestClient(ctx.baseUrl);
    const decoyLogin = await decoy.loginWithNewDevice(alice.username, createIdentity(), {
      password: decoyPassword,
      deviceName: "decoy-device",
    });
    expect(decoyLogin.status).toBe(200);
    expect(decoyLogin.body.user.id).toBe(decoyUser.id);
    expect(decoyLogin.body.user.username).toBe(decoyUsername);

    const decoyConversations = await decoy.request("GET", "/api/conversations");
    expect(decoyConversations.status).toBe(200);
    expect(decoyConversations.body.conversations).toHaveLength(0);
    expect(
      await decoy.request("GET", `/api/conversations/${realConversationId}`),
    ).toMatchObject({ status: 404 });

    const wrong = await new TestClient(ctx.baseUrl).request("POST", "/api/auth/login", {
      body: {
        username: alice.username,
        password: "definitely-wrong-password",
        deviceId: alice.deviceId,
      },
    });
    expect(wrong.status).toBe(401);
  });
});
