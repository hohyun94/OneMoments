import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

import { vapidAuthorization, type VapidKeys } from "./vapid.js";

export interface PushKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionLike extends PushKeys {
  endpoint: string;
}

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64");
}

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** 구독 키 길이를 검증하고 canonical base64url 로 돌려준다. */
export function normalizePushKeys(p256dh: string, auth: string): PushKeys {
  const publicKey = decodeBase64Url(p256dh);
  const authSecret = decodeBase64Url(auth);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("p256dh must be a 65-byte uncompressed P-256 key");
  }
  if (authSecret.length !== 16) {
    throw new Error("auth must be a 16-byte secret");
  }
  return {
    p256dh: encodeBase64Url(publicKey),
    auth: encodeBase64Url(authSecret),
  };
}

/**
 * RFC 8291(aes128gcm) Web Push 본문을 만든다.
 * 형식: salt(16) | rs(4) | idlen(1) | as_public(65) | AES-128-GCM(ciphertext+tag)
 */
export function encryptWebPushPayload(
  payload: Buffer,
  keys: PushKeys,
): Buffer {
  const userAgentPublic = decodeBase64Url(keys.p256dh);
  const authSecret = decodeBase64Url(keys.auth);

  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(null, "uncompressed");
  const sharedSecret = ecdh.computeSecret(userAgentPublic);

  const prk = Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      authSecret,
      Buffer.concat([
        Buffer.from("WebPush: info\0", "utf8"),
        userAgentPublic,
        asPublic,
      ]),
      32,
    ),
  );
  const salt = randomBytes(16);
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

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 레코드 구분자 0x02 뒤에 패딩이 올 수 있다. 여기서는 패딩 없이 단일 레코드로 보낸다.
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  return Buffer.concat([
    salt,
    recordSize,
    Buffer.from([asPublic.length]),
    asPublic,
    ciphertext,
  ]);
}

/** 브라우저 벤더의 푸시 서비스 호스트만 허용한다(SSRF 방지). */
export function isAllowedPushEndpoint(endpoint: URL, allowLocal: boolean): boolean {
  if (endpoint.protocol === "http:" && allowLocal) {
    return (
      endpoint.hostname === "localhost" ||
      endpoint.hostname === "127.0.0.1" ||
      endpoint.hostname === "[::1]"
    );
  }
  if (endpoint.protocol !== "https:") return false;
  const host = endpoint.hostname.toLowerCase();
  return (
    host === "fcm.googleapis.com" ||
    host === "android.googleapis.com" ||
    host === "updates.push.services.mozilla.com" ||
    host === "web.push.apple.com" ||
    host.endsWith(".push.apple.com") ||
    host.endsWith(".push.services.mozilla.com") ||
    host.endsWith(".notify.windows.com")
  );
}

export async function sendWebPush(
  subscription: PushSubscriptionLike,
  payload: Buffer,
  vapid: VapidKeys,
  ttlSeconds: number,
): Promise<number> {
  const body = encryptWebPushPayload(payload, {
    p256dh: subscription.p256dh,
    auth: subscription.auth,
  });
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      authorization: vapidAuthorization(subscription.endpoint, vapid),
      ttl: String(ttlSeconds),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      urgency: "normal",
    },
    body: body as unknown as string,
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  // 본문을 읽어 연결을 정리한다(푸시 서비스는 보통 빈 본문).
  await response.arrayBuffer().catch(() => undefined);
  return response.status;
}
