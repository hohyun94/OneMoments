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

describe("idle logout settings", () => {
  it("defaults to five minutes per device", async () => {
    const alice = await registerAccount("alice");
    expect(alice.client.csrfToken).toBeTypeOf("string");

    const devices = await alice.client.request("GET", "/api/devices");
    expect(devices.status).toBe(200);
    expect(devices.body.devices).toHaveLength(1);
    expect(devices.body.devices[0].idleTimeoutSeconds).toBe(300);

    const me = await alice.client.request("GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.deviceIdleTimeoutSeconds).toBe(300);
    expect(me.body.idleTimeoutSeconds).toBe(300);
    expect(me.body.sessionIdleTimeoutSeconds).toBeNull();
  });

  it("stores a device default without affecting other devices", async () => {
    const alice = await registerAccount("alice");
    const secondIdentity = createIdentity();
    const second = new TestClient(ctx.baseUrl);
    const secondLogin = await second.loginWithNewDevice(alice.username, secondIdentity, {
      deviceName: "laptop",
    });
    const secondDeviceId = secondLogin.body.device.id as string;

    const updated = await alice.client.request(
      "PUT",
      `/api/devices/${alice.deviceId}/timeout`,
      { body: { seconds: 60 } },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.device.idleTimeoutSeconds).toBe(60);

    const aliceMe = await alice.client.request("GET", "/api/auth/me");
    expect(aliceMe.body.deviceIdleTimeoutSeconds).toBe(60);
    expect(aliceMe.body.idleTimeoutSeconds).toBe(60);

    // 다른 기기의 기본값은 그대로 5분이다.
    const secondMe = await second.request("GET", "/api/auth/me");
    expect(secondMe.body.deviceIdleTimeoutSeconds).toBe(300);
    expect(secondMe.body.idleTimeoutSeconds).toBe(300);
    expect(secondMe.body.devices).toHaveLength(2);
    expect(
      secondMe.body.devices.find(
        (device: { id: string }) => device.id === secondDeviceId,
      ).idleTimeoutSeconds,
    ).toBe(300);
  });

  it("lets the current session override the device default", async () => {
    const alice = await registerAccount("alice");

    const override = await alice.client.request("PUT", "/api/auth/session/timeout", {
      body: { seconds: 1800 },
    });
    expect(override.status).toBe(200);
    expect(override.body.idleTimeoutSeconds).toBe(1800);

    const meOverridden = await alice.client.request("GET", "/api/auth/me");
    expect(meOverridden.body.deviceIdleTimeoutSeconds).toBe(300);
    expect(meOverridden.body.sessionIdleTimeoutSeconds).toBe(1800);
    expect(meOverridden.body.idleTimeoutSeconds).toBe(1800);

    // 세션 오버라이드를 지우면 기기 기본값으로 돌아간다.
    const cleared = await alice.client.request("PUT", "/api/auth/session/timeout", {
      body: { seconds: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.idleTimeoutSeconds).toBeNull();

    const meCleared = await alice.client.request("GET", "/api/auth/me");
    expect(meCleared.body.sessionIdleTimeoutSeconds).toBeNull();
    expect(meCleared.body.idleTimeoutSeconds).toBe(300);
  });

  it("resets the session override on re-login", async () => {
    const alice = await registerAccount("alice");
    await alice.client.request("PUT", `/api/devices/${alice.deviceId}/timeout`, {
      body: { seconds: 600 },
    });
    await alice.client.request("PUT", "/api/auth/session/timeout", {
      body: { seconds: 60 },
    });

    const relogin = new TestClient(ctx.baseUrl);
    const login = await relogin.request("POST", "/api/auth/login", {
      body: {
        username: alice.username,
        password: "password-12345",
        deviceId: alice.deviceId,
      },
    });
    expect(login.status).toBe(200);
    expect(login.body.idleTimeoutSeconds).toBe(600);

    const me = await relogin.request("GET", "/api/auth/me");
    expect(me.body.deviceIdleTimeoutSeconds).toBe(600);
    expect(me.body.sessionIdleTimeoutSeconds).toBeNull();
    expect(me.body.idleTimeoutSeconds).toBe(600);
  });

  it("rejects out-of-range values and foreign devices", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");

    const tooShort = await alice.client.request(
      "PUT",
      `/api/devices/${alice.deviceId}/timeout`,
      { body: { seconds: 30 } },
    );
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error.code).toBe("VALIDATION_ERROR");

    const tooLong = await alice.client.request("PUT", "/api/auth/session/timeout", {
      body: { seconds: 31 * 60 },
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe("VALIDATION_ERROR");

    const missing = await alice.client.request(
      "PUT",
      `/api/devices/${alice.deviceId}/timeout`,
      { body: {} },
    );
    expect(missing.status).toBe(400);

    // 다른 사용자의 기기는 찾을 수 없는 것으로 처리한다.
    const foreign = await bob.client.request(
      "PUT",
      `/api/devices/${alice.deviceId}/timeout`,
      { body: { seconds: 300 } },
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("DEVICE_NOT_FOUND");
  });

  it("requires CSRF for timeout changes", async () => {
    const alice = await registerAccount("alice");

    const noCsrf = await alice.client.request(
      "PUT",
      `/api/devices/${alice.deviceId}/timeout`,
      { body: { seconds: 600 }, csrf: false },
    );
    expect(noCsrf.status).toBe(403);

    const sessionNoCsrf = await alice.client.request(
      "PUT",
      "/api/auth/session/timeout",
      { body: { seconds: 600 }, csrf: false },
    );
    expect(sessionNoCsrf.status).toBe(403);
  });
});
