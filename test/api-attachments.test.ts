import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  cleanupOrphanAttachments,
  createAttachmentStorage,
} from "../src/services/attachments.js";
import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity, type Identity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";

interface Account {
  client: TestClient;
  identity: Identity;
  userId: string;
  username: string;
}

let ctx: TestContext;

async function registerAccount(prefix: string): Promise<Account> {
  const client = new TestClient(ctx.baseUrl);
  const identity = createIdentity();
  const username = `${prefix}${randomUUID().slice(0, 8)}`;
  const response = await client.register(username, identity);
  expect(response.status).toBe(201);
  return { client, identity, userId: response.body.user.id, username };
}

async function createConversation(initiator: Account, peer: Account): Promise<string> {
  const response = await initiator.client.request("POST", "/api/conversations", {
    body: { peerUserId: peer.userId },
  });
  expect(response.status).toBe(201);
  return response.body.conversation.id;
}

function upload(
  account: Account,
  conversationId: string,
  data: Uint8Array,
  contentType = "application/octet-stream",
  clientMessageId?: string,
) {
  return account.client.request(
    "POST",
    `/api/conversations/${conversationId}/attachments`,
    {
      rawBody: data,
      headers: {
        "content-type": contentType,
        ...(clientMessageId
          ? { "x-attachment-client-message-id": clientMessageId }
          : {}),
      },
    },
  );
}

async function download(
  client: TestClient,
  attachmentId: string,
): Promise<{ status: number; bytes: Buffer; headers: Headers }> {
  const response = await fetch(`${ctx.baseUrl}/api/attachments/${attachmentId}`, {
    headers: { cookie: client.cookieHeader() },
  });
  return {
    status: response.status,
    bytes: Buffer.from(await response.arrayBuffer()),
    headers: response.headers,
  };
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await rm(".test-artifacts/attachments", { recursive: true, force: true });
  await ctx.close();
});

beforeEach(async () => {
  await resetDatabase(ctx.db);
});

describe("encrypted attachments", () => {
  it("stores opaque bytes and serves them only to conversation participants", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const eve = await registerAccount("eve");
    const conversationId = await createConversation(alice, bob);
    const data = randomBytes(1024);

    const uploaded = await upload(alice, conversationId, data);
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.attachment.size).toBe(data.byteLength);
    const attachmentId = uploaded.body.attachment.id as string;

    const asAlice = await download(alice.client, attachmentId);
    expect(asAlice.status).toBe(200);
    expect(asAlice.bytes.equals(data)).toBe(true);
    expect(asAlice.headers.get("content-type")).toBe("application/octet-stream");
    expect(asAlice.headers.get("content-disposition")).toContain("attachment.bin");

    const asBob = await download(bob.client, attachmentId);
    expect(asBob.status).toBe(200);
    expect(asBob.bytes.equals(data)).toBe(true);

    expect((await download(eve.client, attachmentId)).status).toBe(404);
    expect((await download(new TestClient(ctx.baseUrl), attachmentId)).status).toBe(401);
    expect((await download(alice.client, randomUUID())).status).toBe(404);
  });

  it("supports HTTP range requests for the ciphertext", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const data = randomBytes(64);

    const uploaded = await upload(alice, conversationId, data);
    expect(uploaded.status).toBe(201);
    const attachmentId = uploaded.body.attachment.id as string;

    const full = await download(bob.client, attachmentId);
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.bytes.equals(data)).toBe(true);

    const request = (range: string) =>
      fetch(`${ctx.baseUrl}/api/attachments/${attachmentId}`, {
        headers: { cookie: bob.client.cookieHeader(), range },
      });

    const partial = await request("bytes=0-9");
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 0-9/${data.byteLength}`);
    expect(Buffer.from(await partial.arrayBuffer()).equals(data.subarray(0, 10))).toBe(true);

    const suffix = await request("bytes=-8");
    expect(suffix.status).toBe(206);
    expect(Buffer.from(await suffix.arrayBuffer()).equals(data.subarray(-8))).toBe(true);

    const open = await request("bytes=60-");
    expect(open.status).toBe(206);
    expect(Buffer.from(await open.arrayBuffer()).equals(data.subarray(60))).toBe(true);

    const invalid = await request(`bytes=${data.byteLength}-`);
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe(`bytes */${data.byteLength}`);
  });

  it("enforces size, content type, and upload participation", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const eve = await registerAccount("eve");
    const conversationId = await createConversation(alice, bob);

    const tooLarge = await upload(alice, conversationId, randomBytes(4097));
    expect(tooLarge.status).toBe(413);

    const empty = await upload(alice, conversationId, new Uint8Array());
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe("EMPTY_ATTACHMENT");

    const wrongType = await alice.client.request(
      "POST",
      `/api/conversations/${conversationId}/attachments`,
      { body: { data: "not-binary" } },
    );
    expect(wrongType.status).toBe(415);

    expect((await upload(eve, conversationId, randomBytes(64))).status).toBe(404);
    expect((await upload(alice, "not-a-uuid", randomBytes(64))).status).toBe(400);
    expect((await upload(alice, randomUUID(), randomBytes(64))).status).toBe(404);
  });

  it("lets every group participant download an attachment", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const dave = await registerAccount("dave");
    const created = await alice.client.request("POST", "/api/conversations", {
      body: {
        kind: "group",
        name: "파일 공유",
        memberUserIds: [bob.userId],
      },
    });
    expect(created.status).toBe(201);
    const conversationId = created.body.conversation.id as string;
    const data = randomBytes(2048);

    const uploaded = await upload(bob, conversationId, data);
    expect(uploaded.status).toBe(201);
    const attachmentId = uploaded.body.attachment.id as string;

    const asAlice = await download(alice.client, attachmentId);
    expect(asAlice.status).toBe(200);
    expect(asAlice.bytes.equals(data)).toBe(true);
    expect((await download(dave.client, attachmentId)).status).toBe(404);
  });

  it("cleans only old unlinked uploads and keeps legacy rows", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);

    const orphan = await upload(
      alice,
      conversationId,
      randomBytes(64),
      "application/octet-stream",
      randomUUID(),
    );
    expect(orphan.status).toBe(201);
    const orphanId = orphan.body.attachment.id as string;

    const legacy = await upload(alice, conversationId, randomBytes(64));
    expect(legacy.status).toBe(201);
    const legacyId = legacy.body.attachment.id as string;

    await ctx.db.execute(
      sql`update attachments set created_at = now() - interval '2 days' where id in (${orphanId}, ${legacyId})`,
    );
    const removed = await cleanupOrphanAttachments(
      ctx.db,
      createAttachmentStorage(ctx.config),
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    );
    expect(removed).toBe(1);
    expect((await download(alice.client, orphanId)).status).toBe(404);
    expect((await download(alice.client, legacyId)).status).toBe(200);
  });

});
