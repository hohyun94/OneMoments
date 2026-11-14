import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { encryptWebPushPayload, isAllowedPushEndpoint, sendWebPush } from "../src/push/webPush.js";
import { createVapidKeys, vapidAuthorization } from "../src/push/vapid.js";
import {
  listActiveSubscriptions,
  removePushSubscription,
  sendMessagePushes,
  upsertPushSubscription,
} from "../src/services/push.js";
import { createTestContext, resetDatabase, type TestContext } from "./support/context.js";
import type { MessageRow } from "../src/db/schema.js";
import { createIdentity } from "./support/crypto.js";
import { TestClient } from "./support/http.js";

let ctx: TestContext;

function base64url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64");
}

function subscriptionKeys() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.privateKey.export({ format: "jwk" });
  const x = decodeBase64Url(jwk.x as string);
  const y = decodeBase64Url(jwk.y as string);
  return {
    privateKey: pair.privateKey,
    p256dh: base64url(Buffer.concat([Buffer.from([0x04]), x, y])),
    auth: base64url(randomBytes(16)),
  };
}

/** 테스트용 RFC 8291 복호화. encryptWebPushPayload 의 역순이다. */
function decryptWebPushBody(
  body: Buffer,
  keys: {
    privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
    p256dh: string;
    auth: string;
  },
): Buffer {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const userAgentPublic = decodeBase64Url(keys.p256dh);

  const ecdh = createECDH("prime256v1");
  const jwk = keys.privateKey.export({ format: "jwk" });
  ecdh.setPrivateKey(decodeBase64Url(jwk.d as string));
  const shared = ecdh.computeSecret(asPublic);
  const prk = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      decodeBase64Url(keys.auth),
      Buffer.concat([
        Buffer.from("WebPush: info\0", "utf8"),
        userAgentPublic,
        asPublic,
      ]),
      32,
    ),
  );
  const cek = Buffer.from(
    hkdfSync(
      "sha256",
      prk,
      salt,
      Buffer.from("Content-Encoding: aes128gcm\0", "utf8"),
      16,
    ),
  );
  const nonce = Buffer.from(
    hkdfSync(
      "sha256",
      prk,
      salt,
      Buffer.from("Content-Encoding: nonce\0", "utf8"),
      12,
    ),
  );
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
}

function vapidTestConfig(): Config {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.privateKey.export({ format: "jwk" });
  const x = decodeBase64Url(jwk.x as string);
  const y = decodeBase64Url(jwk.y as string);
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://test",
    VAPID_PUBLIC_KEY: base64url(Buffer.concat([Buffer.from([0x04]), x, y])),
    VAPID_PRIVATE_KEY: jwk.d as string,
    VAPID_SUBJECT: "mailto:push@example.com",
  });
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

describe("web push", () => {
  it("encrypts and decrypts an aes128gcm payload", () => {
    const keys = subscriptionKeys();
    const payload = Buffer.from(JSON.stringify({ body: "새 메시지", conversationId: "c1" }));
    const body = encryptWebPushPayload(payload, {
      p256dh: keys.p256dh,
      auth: keys.auth,
    });
    const decrypted = decryptWebPushBody(body, keys);
    expect(decrypted[decrypted.length - 1]).toBe(0x02);
    expect(decrypted.subarray(0, decrypted.length - 1).toString("utf8")).toBe(
      payload.toString("utf8"),
    );
  });

  it("creates a verifiable VAPID ES256 authorization header", () => {
    const config = vapidTestConfig();
    const vapid = createVapidKeys(config);
    if (!vapid) throw new Error("missing vapid keys");
    const authorization = vapidAuthorization("https://push.example.com/send/abc", vapid);
    expect(authorization).toContain("vapid t=");

    const token = authorization.match(/vapid t=([^,]+), k=/)?.[1];
    if (!token) throw new Error("missing token");
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) throw new Error("invalid JWT");
    expect(JSON.parse(decodeBase64Url(payload).toString("utf8"))).toMatchObject({
      aud: "https://push.example.com",
      sub: "mailto:push@example.com",
    });
    const publicKey = createPublicKey(vapid.privateKey);
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        decodeBase64Url(signature),
      ),
    ).toBe(true);
  });

  it("posts an encrypted payload to the push endpoint", async () => {
    const keys = subscriptionKeys();
    const config = vapidTestConfig();
    const vapid = createVapidKeys(config);
    if (!vapid) throw new Error("missing vapid keys");

    let received: { headers: Record<string, string | string[] | undefined>; body: Buffer } | null =
      null;
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received = { headers: req.headers, body: Buffer.concat(chunks) };
        res.statusCode = 201;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const endpoint = `http://127.0.0.1:${port}/push/abc`;

    try {
      const payload = Buffer.from(JSON.stringify({ title: "OneMoments" }));
      const status = await sendWebPush(
        { endpoint, p256dh: keys.p256dh, auth: keys.auth },
        payload,
        vapid,
        60,
      );
      expect(status).toBe(201);
      const captured = received as
        | { headers: Record<string, string | string[] | undefined>; body: Buffer }
        | null;
      if (!captured) throw new Error("missing request");
      expect(captured.headers["content-encoding"]).toBe("aes128gcm");
      expect(String(captured.headers.authorization)).toContain("vapid t=");
      const decrypted = decryptWebPushBody(captured.body, keys);
      expect(decrypted.subarray(0, decrypted.length - 1).toString("utf8")).toBe(
        payload.toString("utf8"),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("only allows known push service hosts", () => {
    expect(
      isAllowedPushEndpoint(new URL("https://fcm.googleapis.com/fcm/send/abc"), false),
    ).toBe(true);
    expect(
      isAllowedPushEndpoint(
        new URL("https://updates.push.services.mozilla.com/wpush/v2/abc"),
        false,
      ),
    ).toBe(true);
    expect(
      isAllowedPushEndpoint(new URL("https://web.push.apple.com/abc"), false),
    ).toBe(true);
    expect(isAllowedPushEndpoint(new URL("https://evil.example.com/push"), false)).toBe(
      false,
    );
    expect(isAllowedPushEndpoint(new URL("http://127.0.0.1:9000/push"), true)).toBe(true);
    expect(isAllowedPushEndpoint(new URL("http://127.0.0.1:9000/push"), false)).toBe(
      false,
    );
  });

  it("stores subscriptions and reports push disabled when VAPID is missing", async () => {
    const aliceClient = new TestClient(ctx.baseUrl);
    const identity = createIdentity();
    const registered = await aliceClient.register(`alice${randomBytes(4).toString("hex")}`, identity);
    expect(registered.status).toBe(201);
    const userId = registered.body.user.id as string;
    const deviceId = registered.body.device.id as string;

    const publicKey = await aliceClient.request("GET", "/api/push/public-key");
    expect(publicKey.status).toBe(503);
    expect(publicKey.body.error.code).toBe("PUSH_DISABLED");

    const keys = subscriptionKeys();
    const endpoint = "https://push.example.com/sub/1";
    const subscription = await upsertPushSubscription(ctx.db, {
      userId,
      deviceId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    });
    expect(subscription.endpoint).toBe(endpoint);

    const active = await listActiveSubscriptions(ctx.db, {
      userIds: [userId],
      excludeDeviceId: "00000000-0000-4000-8000-000000000000",
    });
    expect(active.map((row) => row.id)).toContain(subscription.id);

    await removePushSubscription(ctx.db, { userId, deviceId, endpoint });
    expect(await listActiveSubscriptions(ctx.db, { userIds: [userId] })).toHaveLength(0);
  });

  it("delivers a message notification without plaintext metadata", async () => {
    const aliceClient = new TestClient(ctx.baseUrl);
    const identity = createIdentity();
    const registered = await aliceClient.register(
      `bob${randomBytes(4).toString("hex")}`,
      identity,
    );
    expect(registered.status).toBe(201);
    const userId = registered.body.user.id as string;
    const deviceId = registered.body.device.id as string;
    const keys = subscriptionKeys();

    let received: Buffer | null = null;
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received = Buffer.concat(chunks);
        res.statusCode = 201;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const endpoint = `http://127.0.0.1:${port}/push/message`;
    await upsertPushSubscription(ctx.db, {
      userId,
      deviceId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    });

    const conversationId = randomUUID();
    const message = {
      id: randomUUID(),
      conversationId,
      senderUserId: randomUUID(),
      senderDeviceId: randomUUID(),
      ciphertext: "ciphertext",
      nonce: "nonce",
      signature: "signature",
      clientMessageId: "client",
      createdAt: new Date(),
      senderSigningPublicKey: "signing",
    } as MessageRow;

    try {
      await sendMessagePushes(ctx.db, vapidTestConfig(), {
        message,
        participantUserIds: [userId],
        senderDeviceId: randomUUID(),
      });
      const body = received as Buffer | null;
      if (!body) throw new Error("missing push body");
      const decrypted = decryptWebPushBody(body, keys);
      const payload = JSON.parse(
        decrypted.subarray(0, decrypted.length - 1).toString("utf8"),
      ) as { body: string; conversationId: string };
      expect(payload.conversationId).toBe(conversationId);
      expect(payload.body).toBe("새 메시지가 도착했습니다.");
      expect(JSON.stringify(payload)).not.toContain("ciphertext");

      // 음소거한 사용자에게는 보내지 않는다.
      received = null;
      await sendMessagePushes(ctx.db, vapidTestConfig(), {
        message,
        participantUserIds: [userId],
        mutedUserIds: [userId],
        senderDeviceId: randomUUID(),
      });
      expect(received).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

