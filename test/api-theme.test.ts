import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";

interface Account {
  client: TestClient;
  username: string;
  userId: string;
  deviceId: string;
}

let ctx: TestContext;

async function registerAccount(prefix: string): Promise<Account> {
  const client = new TestClient(ctx.baseUrl);
  const username = `${prefix}${randomUUID().slice(0, 8)}`;
  const response = await client.register(username, createIdentity());
  expect(response.status).toBe(201);
  return {
    client,
    username,
    userId: response.body.user.id,
    deviceId: response.body.device.id,
  };
}

async function setTheme(
  client: TestClient,
  theme: { mode: string; accent: string },
  csrf = true,
) {
  return client.request("PUT", "/api/auth/theme", { body: theme, csrf });
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

describe("account theme settings", () => {
  it("defaults to system mode and the violet accent", async () => {
    const alice = await registerAccount("alice");

    const me = await alice.client.request("GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.theme).toEqual({ mode: "system", accent: "violet" });
  });

  it("stores a custom mode and hex accent for the account", async () => {
    const alice = await registerAccount("alice");

    const updated = await setTheme(alice.client, { mode: "dark", accent: "#0EA5E9" });
    expect(updated.status).toBe(200);
    expect(updated.body.theme).toEqual({ mode: "dark", accent: "#0ea5e9" });

    const me = await alice.client.request("GET", "/api/auth/me");
    expect(me.body.theme).toEqual({ mode: "dark", accent: "#0ea5e9" });

    // 같은 기기 재로그인(세션 회전) 후에도 계정 테마가 유지된다.
    const relogin = new TestClient(ctx.baseUrl);
    const login = await relogin.request("POST", "/api/auth/login", {
      body: { username: alice.username, password: "password-12345", deviceId: alice.deviceId },
    });
    expect(login.status).toBe(200);
    expect(login.body.theme).toEqual({ mode: "dark", accent: "#0ea5e9" });
  });

  it("keeps themes separate per account", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");

    await setTheme(alice.client, { mode: "light", accent: "rose" });

    const aliceMe = await alice.client.request("GET", "/api/auth/me");
    expect(aliceMe.body.theme).toEqual({ mode: "light", accent: "rose" });

    const bobMe = await bob.client.request("GET", "/api/auth/me");
    expect(bobMe.body.theme).toEqual({ mode: "system", accent: "violet" });
  });

  it("validates mode, accent format and CSRF", async () => {
    const alice = await registerAccount("alice");

    expect((await setTheme(alice.client, { mode: "neon", accent: "blue" })).status).toBe(400);
    expect((await setTheme(alice.client, { mode: "dark", accent: "purple" })).status).toBe(400);
    expect((await setTheme(alice.client, { mode: "dark", accent: "#12345" })).status).toBe(400);

    const noCsrf = await setTheme(
      alice.client,
      { mode: "dark", accent: "blue" },
      false,
    );
    expect(noCsrf.status).toBe(403);
  });
});
