import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";

const adminUsername = `admin${randomUUID().slice(0, 8)}`;
const adminPassword = "password-12345";

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

async function adminEvents(client: TestClient, userId: string, query = "") {
  return client.request(
    "GET",
    `/api/admin/users/${userId}/auth-events${query ? `?${query}` : ""}`,
  );
}

describe("auth event log", () => {
  beforeEach(async () => {
    ctx = await createTestContext({ adminUsernames: [adminUsername] });
    await resetDatabase(ctx.db);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("records register, login and logout with ip for admins", async () => {
    const adminClient = new TestClient(ctx.baseUrl);
    await adminClient.register(adminUsername, createIdentity(), { password: adminPassword });

    const alice = await registerAccount("alice");
    const login = await alice.client.request("POST", "/api/auth/login", {
      body: { username: alice.username, password: "password-12345", deviceId: alice.deviceId },
    });
    expect(login.status).toBe(200);
    expect((await alice.client.request("POST", "/api/auth/logout")).status).toBe(204);

    const response = await adminEvents(adminClient, alice.userId);
    expect(response.status).toBe(200);
    const names = response.body.events.map((event: { event: string }) => event.event);
    expect(names).toEqual(["logout", "login", "register"]);
    for (const event of response.body.events) {
      expect(event.ip).toBeTypeOf("string");
      expect(event.ip.length).toBeGreaterThan(0);
    }
    // 세션 토큰/비밀번호는 어떤 형태로도 포함되지 않는다.
    expect(response.text.includes("password-12345")).toBe(false);
    expect(response.text.includes("tokenHash")).toBe(false);
  });

  it("records device revocation", async () => {
    const adminClient = new TestClient(ctx.baseUrl);
    await adminClient.register(adminUsername, createIdentity(), { password: adminPassword });
    const alice = await registerAccount("alice");

    const revoked = await alice.client.request("DELETE", `/api/devices/${alice.deviceId}`);
    expect(revoked.status).toBe(200);

    const response = await adminEvents(adminClient, alice.userId);
    const names = response.body.events.map((event: { event: string }) => event.event);
    expect(names).toContain("device_revoked");
  });

  it("paginates newest first", async () => {
    const adminClient = new TestClient(ctx.baseUrl);
    await adminClient.register(adminUsername, createIdentity(), { password: adminPassword });
    const alice = await registerAccount("alice");
    await alice.client.request("POST", "/api/auth/login", {
      body: { username: alice.username, password: "password-12345", deviceId: alice.deviceId },
    });

    const first = await adminEvents(adminClient, alice.userId, "limit=1");
    expect(first.status).toBe(200);
    expect(first.body.events).toHaveLength(1);
    expect(first.body.events[0].event).toBe("login");
    expect(first.body.nextCursor).toBeTypeOf("string");

    const next = await adminEvents(
      adminClient,
      alice.userId,
      `limit=1&before=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(next.status).toBe(200);
    expect(next.body.events[0].event).toBe("register");
  });

  it("is admin only", async () => {
    const alice = await registerAccount("alice");
    const forbidden = await adminEvents(alice.client, alice.userId);
    expect(forbidden.status).toBe(403);

    const anonymous = await adminEvents(new TestClient(ctx.baseUrl), alice.userId);
    expect(anonymous.status).toBe(401);
  });
});
