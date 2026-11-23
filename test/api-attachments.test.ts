import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  cleanupOrphanAttachments,
  createAttachmentStorage,
} from "../src/services/attachments.js";
import { attachments } from "../src/db/schema.js";
import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import { createIdentity, encryptMessage, type Identity } from "./support/crypto.js";
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

/**
 * 첨부를 업로드한 뒤 같은 clientMessageId 로 메시지를 보내 첨부를 메시지에 연결한다.
 * (서버는 첨부와 메시지를 clientMessageId 로 연결한다 — 음성 녹음도 같은 경로를 쓴다.)
 */
async function sendAttachmentMessage(
  sender: Account,
  conversationId: string,
  clientMessageId: string,
  data: Uint8Array,
): Promise<{ attachmentId: string; messageId: string }> {
  const uploaded = await upload(
    sender,
    conversationId,
    data,
    "application/octet-stream",
    clientMessageId,
  );
  expect(uploaded.status).toBe(201);
  const attachmentId = uploaded.body.attachment.id as string;

  const devicesResponse = await sender.client.request(
    "GET",
    `/api/conversations/${conversationId}/devices`,
  );
  expect(devicesResponse.status).toBe(200);
  const payload = encryptMessage({
    conversationId,
    clientMessageId,
    plaintext: JSON.stringify({ attachmentId }),
    sender: sender.identity,
    recipients: devicesResponse.body.devices.map(
      (device: { id: string; identityPublicKey: string }) => ({
        deviceId: device.id,
        identityPublicKey: device.identityPublicKey,
      }),
    ),
  });
  const sent = await sender.client.request(
    "POST",
    `/api/conversations/${conversationId}/messages`,
    { body: { ...payload, kind: "text" } },
  );
  expect(sent.status).toBe(201);
  return { attachmentId, messageId: sent.body.message.id as string };
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

  it("deletes the attachment blob only when the message is deleted for everyone", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const conversationId = await createConversation(alice, bob);
    const storage = createAttachmentStorage(ctx.config);

    // "모두에게서 전송 취소": 저장소 블롭과 DB 행이 함께 사라져야 한다.
    const data = randomBytes(512);
    const first = await sendAttachmentMessage(alice, conversationId, randomUUID(), data);
    expect((await storage.get(first.attachmentId)).equals(data)).toBe(true);
    expect((await download(bob.client, first.attachmentId)).status).toBe(200);

    const deleted = await alice.client.request(
      "DELETE",
      `/api/conversations/${conversationId}/messages/${first.messageId}?scope=all`,
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.scope).toBe("all");
    expect(deleted.body.deletedMessageIds).toContain(first.messageId);

    await expect(storage.get(first.attachmentId)).rejects.toBeTruthy();
    expect(await ctx.db.select({ id: attachments.id }).from(attachments)).toHaveLength(0);
    expect((await download(bob.client, first.attachmentId)).status).toBe(404);

    // "나에게서만 삭제": 상대가 계속 볼 수 있어야 하므로 서버 첨부는 남는다.
    const kept = randomBytes(256);
    const second = await sendAttachmentMessage(alice, conversationId, randomUUID(), kept);
    const hidden = await bob.client.request(
      "DELETE",
      `/api/conversations/${conversationId}/messages/${second.messageId}?scope=me`,
    );
    expect(hidden.status).toBe(200);
    expect((await storage.get(second.attachmentId)).equals(kept)).toBe(true);
    expect((await download(alice.client, second.attachmentId)).status).toBe(200);
  });

  it("serves a CSP that allows blob media for decrypted voice playback", async () => {
    // 음성은 복호화한 Blob 을 objectURL 로 재생하므로 media-src 가 필요하다.
    const response = await fetch(`${ctx.baseUrl}/healthz`);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("img-src 'self' data: blob:");
    // 위치 공유는 Permissions-Policy 로 같은 출처에만 허용한다(CSP 지시자가 아니다).
    expect(csp).not.toContain("geolocation=");
    const permissions = response.headers.get("permissions-policy") ?? "";
    expect(permissions).toContain("geolocation=(self)");
  });
});
