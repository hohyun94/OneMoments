import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import {
  createIdentity,
  decryptMessage,
  encryptMessage,
  type Identity,
} from "./support/crypto.js";
import { TestClient } from "./support/http.js";
import { momentAttachments, moments } from "../src/db/schema.js";
import { createAttachmentStorage } from "../src/services/attachments.js";
import { cleanupExpiredMoments } from "../src/services/moments.js";

interface Account {
  client: TestClient;
  identity: Identity;
  userId: string;
  deviceId: string;
  username: string;
}

interface ContactDevice {
  id: string;
  identityPublicKey: string;
  signingPublicKey: string;
  signedPreKeyId?: string | null;
  signedPreKeyPublicKey?: string | null;
  signedPreKeySignature?: string | null;
  oneTimePreKeyId?: string | null;
  oneTimePreKeyPublicKey?: string | null;
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

async function createDirect(initiator: Account, peer: Account): Promise<string> {
  const response = await initiator.client.request("POST", "/api/conversations", {
    body: { peerUserId: peer.userId },
  });
  expect(response.status).toBe(201);
  return response.body.conversation.id;
}

async function buildMoment(
  author: Account,
  audienceUserIds: string[],
  plaintext: string,
  attachmentId?: string,
  momentId = randomUUID(),
) {
  const contactsResponse = await author.client.request("GET", "/api/moments/contacts");
  expect(contactsResponse.status).toBe(200);
  const contacts = contactsResponse.body.contacts as Array<{
    id: string;
    devices: ContactDevice[];
  }>;
  const selfDevices = contactsResponse.body.selfDevices as ContactDevice[];
  const audienceDevices = contacts
    .filter((contact) => audienceUserIds.includes(contact.id))
    .flatMap((contact) => contact.devices);
  const devices = [...selfDevices, ...audienceDevices];

  const payload = encryptMessage({
    conversationId: momentId,
    clientMessageId: momentId,
    plaintext,
    sender: author.identity,
    recipients: devices.map((device) => ({
      deviceId: device.id,
      identityPublicKey: device.identityPublicKey,
      signedPreKeyId: device.signedPreKeyId,
      signedPreKeyPublicKey: device.signedPreKeyPublicKey,
      signedPreKeySignature: device.signedPreKeySignature,
      oneTimePreKeyId: device.oneTimePreKeyId,
      oneTimePreKeyPublicKey: device.oneTimePreKeyPublicKey,
    })),
  });

  return {
    id: momentId,
    ...payload,
    audienceUserIds,
    ...(attachmentId ? { attachmentId } : {}),
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

describe("moments", () => {
  it("lists conversation contacts and their active devices", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    await createDirect(alice, bob);

    const response = await alice.client.request("GET", "/api/moments/contacts");
    expect(response.status).toBe(200);
    expect(response.body.selfDevices).toHaveLength(1);
    expect(response.body.contacts).toHaveLength(1);
    expect(response.body.contacts[0].id).toBe(bob.userId);
    expect(response.body.contacts[0].devices).toHaveLength(1);
  });

  it("creates an encrypted moment for the selected audience and records views", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const carol = await registerAccount("carol");
    await createDirect(alice, bob);

    const body = await buildMoment(alice, [bob.userId], "오늘의 순간");
    const created = await alice.client.request("POST", "/api/moments", { body });
    expect(created.status).toBe(201);
    const moment = created.body.moment;
    expect(moment.key).toBeTruthy();
    expect(moment.viewCount).toBe(0);

    const bobFeed = await bob.client.request("GET", "/api/moments/feed");
    expect(bobFeed.status).toBe(200);
    const bobMoment = bobFeed.body.moments.find(
      (item: { id: string }) => item.id === moment.id,
    );
    expect(bobMoment?.key).toBeTruthy();

    const decrypted = decryptMessage({
      identity: bob.identity,
      senderSigningPublicKey: bobMoment.authorSigningPublicKey,
      message: {
        conversationId: bobMoment.id,
        clientMessageId: bobMoment.id,
        ciphertext: bobMoment.ciphertext,
        nonce: bobMoment.nonce,
        signature: bobMoment.signature,
        key: bobMoment.key,
      },
    });
    expect(decrypted).toBe("오늘의 순간");

    expect(bobFeed.body.moments.map((item: { id: string }) => item.id)).toContain(moment.id);

    const carolFeed = await carol.client.request("GET", "/api/moments/feed");
    expect(carolFeed.body.moments).toHaveLength(0);
    expect(
      (await carol.client.request("GET", `/api/moments/${moment.id}`)).status,
    ).toBe(404);

    const viewed = await bob.client.request("POST", `/api/moments/${moment.id}/view`);
    expect(viewed.status).toBe(204);

    const views = await alice.client.request("GET", `/api/moments/${moment.id}/views`);
    expect(views.status).toBe(200);
    expect(views.body.views).toHaveLength(1);
    expect(views.body.views[0].userId).toBe(bob.userId);

    const authorView = await alice.client.request("GET", `/api/moments/${moment.id}`);
    expect(authorView.body.moment.viewCount).toBe(1);

    expect(
      (await bob.client.request("DELETE", `/api/moments/${moment.id}`)).status,
    ).toBe(403);
    expect(
      (await alice.client.request("DELETE", `/api/moments/${moment.id}`)).status,
    ).toBe(204);
    const afterDelete = await bob.client.request("GET", "/api/moments/feed");
    expect(afterDelete.body.moments).toHaveLength(0);
  });

  it("rejects audience members who do not share a conversation", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const carol = await registerAccount("carol");
    await createDirect(alice, bob);

    const body = await buildMoment(alice, [carol.userId], "not allowed");
    const response = await alice.client.request("POST", "/api/moments", { body });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_AUDIENCE");
  });

  it("links an uploaded attachment and restricts downloads to the audience", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    const carol = await registerAccount("carol");
    await createDirect(alice, bob);

    const momentId = randomUUID();
    const upload = await alice.client.request("POST", "/api/moments/attachments", {
      rawBody: Buffer.from("encrypted-image"),
      headers: {
        "content-type": "application/octet-stream",
        "x-moment-id": momentId,
      },
    });
    expect(upload.status).toBe(201);
    const attachmentId = upload.body.attachment.id as string;

    const body = await buildMoment(alice, [bob.userId], "image", attachmentId, momentId);
    const created = await alice.client.request("POST", "/api/moments", { body });
    expect(created.status).toBe(201);

    const bobDownload = await bob.client.request(
      "GET",
      `/api/moments/attachments/${attachmentId}`,
    );
    expect(bobDownload.status).toBe(200);
    expect(
      (await alice.client.request("GET", `/api/moments/attachments/${attachmentId}`)).status,
    ).toBe(200);
    expect(
      (await carol.client.request("GET", `/api/moments/attachments/${attachmentId}`)).status,
    ).toBe(404);
  });

  it("deletes moment attachment blobs when the account is deleted", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    await createDirect(alice, bob);

    const momentId = randomUUID();
    const upload = await alice.client.request("POST", "/api/moments/attachments", {
      rawBody: Buffer.from("encrypted-image"),
      headers: {
        "content-type": "application/octet-stream",
        "x-moment-id": momentId,
      },
    });
    const attachmentId = upload.body.attachment.id as string;
    const body = await buildMoment(alice, [bob.userId], "bye", attachmentId, momentId);
    expect((await alice.client.request("POST", "/api/moments", { body })).status).toBe(201);

    const deleted = await alice.client.request("DELETE", "/api/auth/account", {
      body: { password: "password-12345" },
    });
    expect(deleted.status).toBe(204);

    const storage = createAttachmentStorage(ctx.config);
    await expect(storage.get(attachmentId)).rejects.toBeTruthy();
    expect(await ctx.db.select().from(moments)).toHaveLength(0);
    expect(await ctx.db.select().from(momentAttachments)).toHaveLength(0);
  });

  it("deletes expired moments and their attachments", async () => {
    const alice = await registerAccount("alice");
    const bob = await registerAccount("bob");
    await createDirect(alice, bob);

    const momentId = randomUUID();
    const upload = await alice.client.request("POST", "/api/moments/attachments", {
      rawBody: Buffer.from("encrypted-image"),
      headers: {
        "content-type": "application/octet-stream",
        "x-moment-id": momentId,
      },
    });
    const attachmentId = upload.body.attachment.id as string;
    const body = await buildMoment(alice, [bob.userId], "expiring", attachmentId, momentId);
    expect((await alice.client.request("POST", "/api/moments", { body })).status).toBe(201);

    await ctx.db.execute(
      sql`update ${moments} set expires_at = now() - interval '1 hour' where id = ${momentId}`,
    );
    const storage = createAttachmentStorage(ctx.config);
    const result = await cleanupExpiredMoments(ctx.db, storage, { now: new Date() });
    expect(result.moments).toBe(1);
    expect(result.attachments).toBe(1);
    expect(await ctx.db.select().from(momentAttachments)).toHaveLength(0);
    await expect(storage.get(attachmentId)).rejects.toBeTruthy();

    const feed = await bob.client.request("GET", "/api/moments/feed");
    expect(feed.body.moments).toHaveLength(0);
    expect((await bob.client.request("GET", `/api/moments/${momentId}`)).status).toBe(404);
  });
});
