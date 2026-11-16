import { randomBytes, randomUUID } from "node:crypto";

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
    password: "password-12345",
    userId: response.body.user.id as string,
    deviceId: response.body.device.id as string,
  };
}

async function registerAdmin() {
  const admin = await registerAccount("admin");
  return admin;
}

describe("admin console", () => {
  beforeEach(async () => {
    ctx = await createTestContext({ adminUsernames: [adminUsername] });
    await resetDatabase(ctx.db);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("rejects users outside the ADMIN_USERNAMES allowlist", async () => {
    const alice = await registerAccount("alice");

    const overview = await alice.client.request("GET", "/api/admin/overview");
    expect(overview.status).toBe(403);
    expect(overview.body.error.code).toBe("FORBIDDEN");

    const decoy = await alice.client.request("GET", "/api/admin/decoy");
    expect(decoy.status).toBe(403);

    const anonymous = await new TestClient(ctx.baseUrl).request("GET", "/api/admin/overview");
    expect(anonymous.status).toBe(401);
  });

  it("returns aggregate and per-user metadata without secrets", async () => {
    const adminClient = new TestClient(ctx.baseUrl);
    const registered = await adminClient.register(adminUsername, createIdentity(), {
      password: adminPassword,
    });
    expect(registered.status).toBe(201);
    expect(registered.body.user.isAdmin).toBe(true);

    const alice = await registerAccount("alice");

    const summary = await adminClient.request("GET", "/api/admin/overview");
    expect(summary.status).toBe(200);
    expect(summary.body.overview.usersTotal).toBe(2);
    expect(summary.body.overview.usersDeleted).toBe(0);
    expect(summary.body.overview.devicesActive).toBe(2);
    expect(summary.body.overview.activeSessions).toBe(2);

    const users = await adminClient.request(
      "GET",
      `/api/admin/users?query=${encodeURIComponent(alice.username)}`,
    );
    expect(users.status).toBe(200);
    expect(users.body.users).toHaveLength(1);
    expect(users.body.users[0]).toMatchObject({
      id: alice.userId,
      username: alice.username,
      deleted: false,
      activeDeviceCount: 1,
      activeSessionCount: 1,
    });

    const detail = await adminClient.request("GET", `/api/admin/users/${alice.userId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.user.devices).toHaveLength(1);
    expect(detail.body.user.sessions).toHaveLength(1);
    expect(detail.body.user.counts.messages).toBe(0);
    expect(detail.body.user.decoy).toBeNull();
    expect(detail.text).not.toMatch(/passwordHash|tokenHash|password_hash|token_hash/);
  });

  it("paginates the registered user list with the username cursor", async () => {
    const adminClient = new TestClient(ctx.baseUrl);
    const registered = await adminClient.register(adminUsername, createIdentity(), {
      password: adminPassword,
    });
    expect(registered.status).toBe(201);

    await registerAccount("aa");
    await registerAccount("bb");

    const firstPage = await adminClient.request("GET", "/api/admin/users?limit=2");
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.users).toHaveLength(2);
    expect(firstPage.body.nextCursor).not.toBeNull();

    const secondPage = await adminClient.request(
      "GET",
      `/api/admin/users?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.users).toHaveLength(1);
    expect(secondPage.body.nextCursor).toBeNull();

    const usernames = [...firstPage.body.users, ...secondPage.body.users].map(
      (user: { username: string }) => user.username,
    );
    expect(usernames).toHaveLength(3);
    expect(new Set(usernames).size).toBe(3);
  });

  it("lists active devices with owner metadata and status filters", async () => {
    const adminClient = new TestClient(ctx.baseUrl);
    const registered = await adminClient.register(adminUsername, createIdentity(), {
      password: adminPassword,
    });
    expect(registered.status).toBe(201);
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");

    const active = await adminClient.request("GET", "/api/admin/devices");
    expect(active.status).toBe(200);
    expect(active.body.devices).toHaveLength(3);
    expect(active.body.nextCursor).toBeNull();
    const aliceDevice = active.body.devices.find(
      (device: { id: string }) => device.id === alice.deviceId,
    );
    expect(aliceDevice).toMatchObject({ username: alice.username, revokedAt: null });
    expect(active.text).not.toMatch(
      /identityPublicKey|signingPublicKey|identity_public_key|signing_public_key/,
    );

    const byOwner = await adminClient.request(
      "GET",
      `/api/admin/devices?query=${encodeURIComponent(alice.username)}`,
    );
    expect(byOwner.body.devices).toHaveLength(1);
    expect(byOwner.body.devices[0].id).toBe(alice.deviceId);

    const firstPage = await adminClient.request("GET", "/api/admin/devices?limit=2");
    expect(firstPage.body.devices).toHaveLength(2);
    expect(firstPage.body.nextCursor).not.toBeNull();
    const secondPage = await adminClient.request(
      "GET",
      `/api/admin/devices?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
    );
    expect(secondPage.body.devices).toHaveLength(1);
    expect(secondPage.body.nextCursor).toBeNull();
    const deviceIds = [...firstPage.body.devices, ...secondPage.body.devices].map(
      (device: { id: string }) => device.id,
    );
    expect(new Set(deviceIds).size).toBe(3);

    const revoked = await bob.client.request("DELETE", `/api/devices/${bob.deviceId}`);
    expect(revoked.status).toBe(200);

    const activeAfter = await adminClient.request("GET", "/api/admin/devices");
    expect(
      activeAfter.body.devices.map((device: { id: string }) => device.id),
    ).not.toContain(bob.deviceId);

    const revokedOnly = await adminClient.request("GET", "/api/admin/devices?status=revoked");
    expect(revokedOnly.body.devices).toHaveLength(1);
    expect(revokedOnly.body.devices[0]).toMatchObject({ id: bob.deviceId });
    expect(revokedOnly.body.devices[0].revokedAt).not.toBeNull();
  });

  it("revokes a device with CSRF and records an audit entry", async () => {
    const adminClient = new TestClient(ctx.baseUrl);
    const registered = await adminClient.register(adminUsername, createIdentity(), {
      password: adminPassword,
    });
    expect(registered.status).toBe(201);
    const alice = await registerAccount("alice");

    const withoutCsrf = await adminClient.request(
      "POST",
      `/api/admin/devices/${alice.deviceId}/revoke`,
      { csrf: false },
    );
    expect(withoutCsrf.status).toBe(403);

    const nonAdmin = await alice.client.request(
      "POST",
      `/api/admin/devices/${alice.deviceId}/revoke`,
    );
    expect(nonAdmin.status).toBe(403);

    const revoked = await adminClient.request(
      "POST",
      `/api/admin/devices/${alice.deviceId}/revoke`,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect(revoked.body.device).toMatchObject({
      id: alice.deviceId,
      username: alice.username,
      revokedAt: expect.any(String),
    });
    expect(revoked.text).not.toMatch(
      /identityPublicKey|signingPublicKey|identity_public_key|signing_public_key/,
    );

    // 폐기된 기기의 세션은 즉시 무효화된다.
    expect((await alice.client.request("GET", "/api/auth/me")).status).toBe(401);

    const again = await adminClient.request(
      "POST",
      `/api/admin/devices/${alice.deviceId}/revoke`,
    );
    expect(again.status).toBe(200);
    expect(again.body.revoked).toBe(false);

    const revokedList = await adminClient.request("GET", "/api/admin/devices?status=revoked");
    expect(
      revokedList.body.devices.map((device: { id: string }) => device.id),
    ).toContain(alice.deviceId);

    const audit = await adminClient.request("GET", "/api/admin/audit");
    const entries = audit.body.entries.filter(
      (entry: { action: string }) => entry.action === "device.revoked",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      adminUsername,
      targetUsername: alice.username,
      detail: { deviceName: expect.any(String) },
    });
    expect(audit.text).not.toMatch(/passwordHash|tokenHash|password_hash|token_hash/);
  });

  it("revokes sessions with CSRF and records an audit entry", async () => {
    const adminClient = new TestClient(ctx.baseUrl);
    const registered = await adminClient.register(adminUsername, createIdentity(), {
      password: adminPassword,
    });
    expect(registered.status).toBe(201);
    const alice = await registerAccount("alice");

    const withoutCsrf = await adminClient.request(
      "POST",
      `/api/admin/users/${alice.userId}/revoke-sessions`,
      { csrf: false },
    );
    expect(withoutCsrf.status).toBe(403);

    const revoked = await adminClient.request(
      "POST",
      `/api/admin/users/${alice.userId}/revoke-sessions`,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedSessions).toBe(1);
    expect((await alice.client.request("GET", "/api/auth/me")).status).toBe(401);

    const audit = await adminClient.request("GET", "/api/admin/audit");
    expect(audit.status).toBe(200);
    const entry = audit.body.entries.find(
      (item: { action: string }) => item.action === "user.sessions.revoked",
    );
    expect(entry).toMatchObject({
      targetUsername: alice.username,
      adminUsername,
      detail: { revokedSessions: 1 },
    });
    expect(audit.text).not.toMatch(/passwordHash|tokenHash|password_hash|token_hash/);
  });

  it("creates, rotates and disables decoy profiles without exposing passwords", async () => {
    const adminClient = new TestClient(ctx.baseUrl);
    const registered = await adminClient.register(adminUsername, createIdentity(), {
      password: adminPassword,
    });
    expect(registered.status).toBe(201);
    const alice = await registerAccount("alice");

    const decoyPassword = `decoy-${randomBytes(12).toString("base64url")}`;
    const rotatedPassword = `rotated-${randomBytes(12).toString("base64url")}`;
    const handle = `decoy_${randomUUID().slice(0, 8)}`;

    const created = await adminClient.request("POST", "/api/admin/decoy", {
      body: { alias: alice.username, handle, password: decoyPassword },
    });
    expect(created.status).toBe(201);
    expect(created.body.profile).toMatchObject({
      alias: alice.username,
      handle,
      disabledAt: null,
    });
    expect(created.text).not.toContain(decoyPassword);
    expect(created.text).not.toMatch(/passwordHash|password_hash/);
    const profileId = created.body.profile.id as string;

    const listed = await adminClient.request("GET", "/api/admin/decoy");
    expect(listed.status).toBe(200);
    expect(listed.body.profiles).toHaveLength(1);

    const decoyClient = new TestClient(ctx.baseUrl);
    const decoyLogin = await decoyClient.loginWithNewDevice(alice.username, createIdentity(), {
      password: decoyPassword,
      deviceName: "decoy-device",
    });
    expect(decoyLogin.status).toBe(200);
    expect(decoyLogin.body.user.username).toBe(handle);
    expect(decoyLogin.body.user.id).not.toBe(alice.userId);

    // 실제 비밀번호와 같은 decoy 비밀번호는 거부한다.
    const samePassword = await adminClient.request(
      "POST",
      `/api/admin/decoy/${profileId}/password`,
      { body: { password: alice.password } },
    );
    expect(samePassword.status).toBe(400);
    expect(samePassword.body.error.code).toBe("DECOY_PASSWORD_SAME");

    const rotated = await adminClient.request(
      "POST",
      `/api/admin/decoy/${profileId}/password`,
      { body: { password: rotatedPassword } },
    );
    expect(rotated.status).toBe(200);
    expect(rotated.text).not.toContain(rotatedPassword);

    const oldLogin = await new TestClient(ctx.baseUrl).loginWithNewDevice(
      alice.username,
      createIdentity(),
      { password: decoyPassword },
    );
    expect(oldLogin.status).toBe(401);

    const newLogin = await new TestClient(ctx.baseUrl).loginWithNewDevice(
      alice.username,
      createIdentity(),
      { password: rotatedPassword },
    );
    expect(newLogin.status).toBe(200);

    const disabled = await adminClient.request(
      "POST",
      `/api/admin/decoy/${profileId}/disabled`,
      { body: { disabled: true } },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.profile.disabledAt).toBeTypeOf("string");

    const blockedLogin = await new TestClient(ctx.baseUrl).loginWithNewDevice(
      alice.username,
      createIdentity(),
      { password: rotatedPassword },
    );
    expect(blockedLogin.status).toBe(401);

    const enabled = await adminClient.request(
      "POST",
      `/api/admin/decoy/${profileId}/disabled`,
      { body: { disabled: false } },
    );
    expect(enabled.status).toBe(200);
    expect(enabled.body.profile.disabledAt).toBeNull();

    const audit = await adminClient.request("GET", "/api/admin/audit");
    const actions = audit.body.entries.map((entry: { action: string }) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "decoy.created",
        "decoy.password.rotated",
        "decoy.disabled",
        "decoy.enabled",
      ]),
    );
  });

  it("rejects duplicate decoy profiles and duplicate handles", async () => {
    const adminClient = new TestClient(ctx.baseUrl);
    const registered = await adminClient.register(adminUsername, createIdentity(), {
      password: adminPassword,
    });
    expect(registered.status).toBe(201);
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");

    const decoyPassword = `decoy-${randomBytes(12).toString("base64url")}`;
    const handle = `decoy_${randomUUID().slice(0, 8)}`;
    const created = await adminClient.request("POST", "/api/admin/decoy", {
      body: { alias: alice.username, handle, password: decoyPassword },
    });
    expect(created.status).toBe(201);

    const duplicateAlias = await adminClient.request("POST", "/api/admin/decoy", {
      body: { alias: alice.username, password: decoyPassword },
    });
    expect(duplicateAlias.status).toBe(409);
    expect(duplicateAlias.body.error.code).toBe("DECOY_EXISTS");

    const duplicateHandle = await adminClient.request("POST", "/api/admin/decoy", {
      body: { alias: bob.username, handle, password: decoyPassword },
    });
    expect(duplicateHandle.status).toBe(409);
    expect(duplicateHandle.body.error.code).toBe("HANDLE_TAKEN");

    const missing = await adminClient.request("POST", "/api/admin/decoy", {
      body: { alias: "nobodyhere", password: decoyPassword },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("ALIAS_NOT_FOUND");
  });
});
