import { createECDH, createPrivateKey, sign, timingSafeEqual, type KeyObject } from "node:crypto";

import type { Config } from "../config.js";

export interface VapidKeys {
  publicKey: string;
  privateKey: KeyObject;
  subject: string;
}

interface CachedToken {
  authorization: string;
  expiresAt: number;
}

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64");
}

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * VAPID raw 키(공개 65바이트, 개인 32바이트 base64url)를 검증하고
 * ES256 JWT 서명용 KeyObject 를 만든다. 설정이 없으면 null(푸시 비활성).
 */
export function createVapidKeys(config: Config): VapidKeys | null {
  if (!config.vapidPublicKey || !config.vapidPrivateKey) return null;

  const publicRaw = decodeBase64Url(config.vapidPublicKey);
  const privateRaw = decodeBase64Url(config.vapidPrivateKey);
  if (publicRaw.length !== 65 || publicRaw[0] !== 0x04) {
    throw new Error("VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 key");
  }
  if (privateRaw.length !== 32) {
    throw new Error("VAPID_PRIVATE_KEY must be a 32-byte P-256 private key");
  }

  // 공개키와 개인키가 실제로 같은 키 쌍인지 확인한다.
  const check = createECDH("prime256v1");
  check.setPrivateKey(privateRaw);
  const derived = check.getPublicKey(null, "uncompressed");
  if (!timingSafeEqual(derived, publicRaw)) {
    throw new Error("VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY");
  }

  const x = publicRaw.subarray(1, 33);
  const y = publicRaw.subarray(33, 65);
  const privateKey = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: encodeBase64Url(x),
      y: encodeBase64Url(y),
      d: encodeBase64Url(privateRaw),
    },
    format: "jwk",
  });

  return {
    publicKey: encodeBase64Url(publicRaw),
    privateKey,
    subject: config.vapidSubject,
  };
}

const tokenCache = new Map<string, CachedToken>();

/** VAPID Authorization 헤더. audience(푸시 서비스 origin)별로 12시간 캐시한다. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys): string {
  const audience = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(audience);
  if (cached && cached.expiresAt > now + 60) return cached.authorization;

  const expiresAt = now + 12 * 60 * 60;
  const header = encodeBase64Url(
    Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const payload = encodeBase64Url(
    Buffer.from(
      JSON.stringify({ aud: audience, exp: expiresAt, sub: keys.subject }),
    ),
  );
  const unsigned = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: keys.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  const authorization = `vapid t=${unsigned}.${encodeBase64Url(signature)}, k=${keys.publicKey}`;
  tokenCache.set(audience, { authorization, expiresAt });
  return authorization;
}
