import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.db);
});

describe("device platform metadata", () => {
  it("stores the platform reported at registration and returns it in device lists", async () => {
    const client = new TestClient(ctx.baseUrl);
    const identity = createIdentity();
    const username = `platform${randomUUID().slice(0, 8)}`;

    const registered = await client.register(username, identity, {
      platform: "ios",
    });
    expect(registered.status).toBe(201);
    expect(registered.body.device.platform).toBe("ios");

    const me = await client.request("GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.devices[0].platform).toBe("ios");

    const devices = await client.request("GET", "/api/devices");
    expect(devices.status).toBe(200);
    expect(devices.body.devices[0].platform).toBe("ios");
  });

  it("defaults to unknown when the client omits platform", async () => {
    const client = new TestClient(ctx.baseUrl);
    const identity = createIdentity();
    const username = `legacy${randomUUID().slice(0, 8)}`;

    const registered = await client.register(username, identity);
    expect(registered.status).toBe(201);
    expect(registered.body.device.platform).toBe("unknown");
  });

  it("stores platform for a newly added device and validates the enum", async () => {
    const client = new TestClient(ctx.baseUrl);
    const identity = createIdentity();
    const username = `multi${randomUUID().slice(0, 8)}`;
    const registered = await client.register(username, identity, {
      platform: "desktop",
    });
    expect(registered.status).toBe(201);

    const added = await client.addDevice("phone", createIdentity(), {
      platform: "android",
    });
    expect(added.status).toBe(201);
    expect(added.body.device.platform).toBe("android");

    const devices = await client.request("GET", "/api/devices");
    expect(devices.body.devices.map((device: { platform: string }) => device.platform)).toEqual(
      expect.arrayContaining(["desktop", "android"]),
    );

    const invalidClient = new TestClient(ctx.baseUrl);
    const invalid = await invalidClient.request("POST", "/api/auth/register", {
      body: {
        username: `invalid${randomUUID().slice(0, 8)}`,
        password: "password-12345",
        device: {
          name: "bad-device",
          platform: "symbian",
          identityPublicKey: identity.identity.publicKeyBase64,
          signingPublicKey: identity.signing.publicKeyBase64,
        },
      },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
  });
});
