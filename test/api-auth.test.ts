import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity, type Identity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";

interface Account {
  client: TestClient;
  identity: Identity;
  userId: string;
  deviceId: string;
  username: string;
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

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.db);
});

describe("accounts, sessions and CSRF", () => {
  it("registers with a device key and keeps a session cookie", async () => {
    const alice = await registerAccount("alice");
    expect(alice.client.cookies.has("om_session")).toBe(true);
    expect(alice.client.csrfToken).toBeTypeOf("string");

    const me = await alice.client.request("GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe(alice.username);
    expect(me.body.user.deleted).toBe(false);
    expect(me.body.deviceId).toBe(alice.deviceId);
    expect(me.body.devices).toHaveLength(1);
    expect(me.body.devices[0].identityPublicKey).toBe(alice.identity.identity.publicKeyBase64);
    expect(me.body.devices[0].signingPublicKey).toBe(alice.identity.signing.publicKeyBase64);
  });

  it("rejects duplicate usernames case-insensitively and weak passwords", async () => {
    const alice = await registerAccount("alice");
    const duplicate = new TestClient(ctx.baseUrl);
    const response = await duplicate.register(alice.username.toUpperCase(), createIdentity());
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("USERNAME_TAKEN");

    const weak = new TestClient(ctx.baseUrl);
    const weakResponse = await weak.register(
      `weak${randomUUID().slice(0, 8)}`,
      createIdentity(),
      { password: "short" },
    );
    expect(weakResponse.status).toBe(400);
    expect(weakResponse.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("logs in with an existing device or registers a new one", async () => {
    const alice = await registerAccount("alice");

    const existing = new TestClient(ctx.baseUrl);
    const existingLogin = await existing.request("POST", "/api/auth/login", {
      body: {
        username: alice.username,
        password: "password-12345",
        deviceId: alice.deviceId,
      },
    });
    expect(existingLogin.status).toBe(200);
    expect(existingLogin.body.device.id).toBe(alice.deviceId);

    const secondIdentity = createIdentity();
    const second = new TestClient(ctx.baseUrl);
    const newDeviceLogin = await second.loginWithNewDevice(alice.username, secondIdentity);
    expect(newDeviceLogin.status).toBe(200);
    expect(newDeviceLogin.body.device.id).not.toBe(alice.deviceId);

    const me = await existing.request("GET", "/api/auth/me");
    expect(me.body.devices).toHaveLength(2);
    // 같은 기기 재로그인으로 이전 세션은 회전(무효화)된다.
    expect((await alice.client.request("GET", "/api/auth/me")).status).toBe(401);

    const noDevice = new TestClient(ctx.baseUrl);
    const missing = await noDevice.request("POST", "/api/auth/login", {
      body: { username: alice.username, password: "password-12345" },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("DEVICE_REQUIRED");

    const wrong = new TestClient(ctx.baseUrl);
    const wrongResponse = await wrong.request("POST", "/api/auth/login", {
      body: {
        username: alice.username,
        password: "definitely-wrong",
        deviceId: alice.deviceId,
      },
    });
    expect(wrongResponse.status).toBe(401);
  });

  it("requires a session and rejects logout without CSRF", async () => {
    const anonymous = new TestClient(ctx.baseUrl);
    expect((await anonymous.request("GET", "/api/auth/me")).status).toBe(401);

    const alice = await registerAccount("alice");
    const withoutCsrf = await alice.client.request("POST", "/api/auth/logout", {
      csrf: false,
    });
    expect(withoutCsrf.status).toBe(403);

    const logout = await alice.client.request("POST", "/api/auth/logout");
    expect(logout.status).toBe(204);
    expect((await alice.client.request("GET", "/api/auth/me")).status).toBe(401);
  });

  it("guards state changes with CSRF and Origin", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");

    const noCsrf = await alice.client.request("POST", "/api/conversations", {
      body: { peerUserId: bob.userId },
      csrf: false,
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.message).toMatch(/CSRF/);

    const evilOrigin = await alice.client.request("GET", "/api/auth/me", {
      headers: { origin: "https://evil.example" },
    });
    expect(evilOrigin.status).toBe(403);

    const allowed = await alice.client.request("POST", "/api/conversations", {
      body: { peerUserId: bob.userId },
    });
    expect(allowed.status).toBe(201);
  });

  it("lists and revokes devices, invalidating their sessions", async () => {
    const alice = await registerAccount("alice");
    const laptopIdentity = createIdentity();
    const laptop = new TestClient(ctx.baseUrl);
    const laptopLogin = await laptop.loginWithNewDevice(alice.username, laptopIdentity, {
      deviceName: "laptop",
    });
    expect(laptopLogin.status).toBe(200);
    const laptopDeviceId = laptopLogin.body.device.id as string;

    const devices = await alice.client.request("GET", "/api/devices");
    expect(devices.body.devices).toHaveLength(2);

    const revoked = await alice.client.request("DELETE", `/api/devices/${laptopDeviceId}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.device.revokedAt).toBeTypeOf("string");

    expect((await laptop.request("GET", "/api/auth/me")).status).toBe(401);
    expect((await alice.client.request("GET", "/api/auth/me")).status).toBe(200);
  });

  it("finds users only by exact username", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");

    const exact = await alice.client.request(
      "GET",
      `/api/users/search?username=${encodeURIComponent(bob.username.toUpperCase())}`,
    );
    expect(exact.status).toBe(200);
    expect(exact.body.user.id).toBe(bob.userId);
    expect(exact.body.user.deleted).toBe(false);

    const partial = await alice.client.request("GET", "/api/users/search?username=bobxyz");
    expect(partial.status).toBe(200);
    expect(partial.body.user).toBeNull();

    const self = await alice.client.request(
      "GET",
      `/api/users/search?username=${encodeURIComponent(alice.username)}`,
    );
    expect(self.body.user).toBeNull();
  });
});
