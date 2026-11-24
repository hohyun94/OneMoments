import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity, type Identity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";

interface Account {
  client: TestClient;
  identity: Identity;
  userId: string;
  username: string;
}

/** 1x1 PNG. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let ctx: TestContext;

async function registerAccount(prefix: string): Promise<Account> {
  const client = new TestClient(ctx.baseUrl);
  const identity = createIdentity();
  const username = `${prefix}${randomUUID().slice(0, 8)}`;
  const response = await client.register(username, identity);
  expect(response.status).toBe(201);
  return { client, identity, userId: response.body.user.id, username };
}

/** 아바타는 바이너리 응답이라 TestClient(JSON) 대신 직접 받는다. */
async function fetchAvatar(
  client: TestClient,
  userId: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; mime: string | null; buffer: Buffer; etag: string | null }> {
  const response = await fetch(`${ctx.baseUrl}/api/users/${userId}/avatar`, {
    headers: { cookie: client.cookieHeader(), ...headers },
  });
  return {
    status: response.status,
    mime: response.headers.get("content-type"),
    buffer: Buffer.from(await response.arrayBuffer()),
    etag: response.headers.get("etag"),
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

describe("profile avatar", () => {
  it("stores a public avatar that other signed-in users can fetch with an ETag", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");

    const uploaded = await alice.client.request("PUT", "/api/auth/profile/avatar", {
      body: { mime: "image/png", data: TINY_PNG.toString("base64") },
    });
    expect(uploaded.status).toBe(200);
    expect(typeof uploaded.body.user.avatarUpdatedAt).toBe("string");

    const fetched = await fetchAvatar(bob.client, alice.userId);
    expect(fetched.status).toBe(200);
    expect(fetched.mime).toBe("image/png");
    expect(fetched.buffer.equals(TINY_PNG)).toBe(true);
    expect(fetched.etag).toBeTruthy();

    // 같은 ETag 로 다시 요청하면 본문 없이 304.
    const cached = await fetchAvatar(bob.client, alice.userId, {
      "if-none-match": fetched.etag as string,
    });
    expect(cached.status).toBe(304);

    // 연락처(대화 상대) 목록에도 아바타 변경 시각이 실린다.
    const conversation = await alice.client.request("POST", "/api/conversations", {
      body: { peerUserId: bob.userId },
    });
    expect(conversation.status).toBe(201);
    const contacts = await alice.client.request("GET", "/api/contacts");
    expect(contacts.status).toBe(200);
    const bobContact = (contacts.body.contacts as Array<{ id: string; avatarUpdatedAt: string | null }>)
      .find((item) => item.id === bob.userId);
    expect(bobContact?.avatarUpdatedAt).toBeNull();
  });

  it("rejects unsupported types and oversized payloads", async () => {
    const alice = await registerAccount("alice");

    const badType = await alice.client.request("PUT", "/api/auth/profile/avatar", {
      body: { mime: "image/gif", data: TINY_PNG.toString("base64") },
    });
    expect(badType.status).toBe(400);

    const tooLarge = await alice.client.request("PUT", "/api/auth/profile/avatar", {
      body: { mime: "image/png", data: Buffer.alloc(70 * 1024, 1).toString("base64") },
    });
    expect(tooLarge.status).toBe(400);

    const notBase64 = await alice.client.request("PUT", "/api/auth/profile/avatar", {
      body: { mime: "image/png", data: "!!!not-base64!!!" },
    });
    expect(notBase64.status).toBe(400);
  });

  it("deletes the avatar and stops serving it", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");

    await alice.client.request("PUT", "/api/auth/profile/avatar", {
      body: { mime: "image/png", data: TINY_PNG.toString("base64") },
    });
    expect((await fetchAvatar(bob.client, alice.userId)).status).toBe(200);

    const removed = await alice.client.request("DELETE", "/api/auth/profile/avatar");
    expect(removed.status).toBe(200);
    expect(removed.body.user.avatarUpdatedAt).toBeNull();
    expect((await fetchAvatar(bob.client, alice.userId)).status).toBe(404);
  });

  it("requires a session to read avatars", async () => {
    const alice = await registerAccount("alice");
    await alice.client.request("PUT", "/api/auth/profile/avatar", {
      body: { mime: "image/png", data: TINY_PNG.toString("base64") },
    });

    const anonymous = await fetch(`${ctx.baseUrl}/api/users/${alice.userId}/avatar`);
    expect(anonymous.status).toBe(401);
  });
});
