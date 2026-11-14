import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../src/auth/password.js";
import {
  deriveCsrfToken,
  generateSessionToken,
  hashSessionToken,
  verifyCsrfToken,
} from "../src/auth/session.js";
import {
  normalizeDeviceKeys,
  normalizeMessagePayload,
  signedPreKeyMessage,
  type MessagePayloadInput,
} from "../src/crypto/envelope.js";
import { AppError } from "../src/http/errors.js";
import { createIdentity as createTestIdentity } from "./support/crypto.js";

const b64 = (bytes: number) => randomBytes(bytes).toString("base64");

function validPayload(): MessagePayloadInput {
  return {
    clientMessageId: "msg-1",
    ciphertext: b64(32),
    nonce: b64(12),
    signature: b64(64),
    keys: [
      {
        deviceId: "11111111-1111-4111-8111-111111111111",
        ephemeralPublicKey: b64(32),
        wrappedKey: b64(48),
        wrapNonce: b64(12),
        version: 1,
      },
    ],
  };
}

const options = { maxCiphertextBytes: 1024, maxEnvelopes: 10 };

describe("password hashing", () => {
  it("verifies the correct password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$16384$8$1$")).toBe(true);
    await expect(verifyPassword("correct horse battery staple", stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong password entirely", stored)).resolves.toBe(false);
  });

  it("rejects malformed stored hashes", async () => {
    await expect(verifyPassword("anything", "not-a-hash")).resolves.toBe(false);
    await expect(
      verifyPassword("anything", "scrypt$999999999$8$1$c2FsdA==$aGFzaA=="),
    ).resolves.toBe(false);
  });
});

describe("sessions and CSRF", () => {
  it("stores only a hash of the session token", () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(token.length).toBeGreaterThan(20);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it("derives a deterministic CSRF token and rejects mismatches", () => {
    const token = generateSessionToken();
    const secret = "unit-test-session-secret-0123456789abcdef";
    const csrf = deriveCsrfToken(token, secret);
    expect(deriveCsrfToken(token, secret)).toBe(csrf);
    expect(verifyCsrfToken(csrf, token, secret)).toBe(true);
    expect(verifyCsrfToken(`${csrf}x`, token, secret)).toBe(false);
    expect(verifyCsrfToken(csrf, generateSessionToken(), secret)).toBe(false);
    expect(verifyCsrfToken("", token, secret)).toBe(false);
  });
});

describe("device keys and message envelopes", () => {
  it("accepts 32-byte X25519/Ed25519 public keys", () => {
    const keys = { identityPublicKey: b64(32), signingPublicKey: b64(32) };
    expect(normalizeDeviceKeys(keys)).toEqual({
      ...keys,
      signedPreKey: null,
      oneTimePreKeys: [],
    });
  });

  it("rejects wrong device key sizes", () => {
    expect(() =>
      normalizeDeviceKeys({ identityPublicKey: b64(31), signingPublicKey: b64(32) }),
    ).toThrow(AppError);
    expect(() =>
      normalizeDeviceKeys({ identityPublicKey: b64(32), signingPublicKey: b64(33) }),
    ).toThrow(AppError);
  });

  it("normalizes a well-formed message payload", () => {
    const payload = validPayload();
    const normalized = normalizeMessagePayload(payload, options);
    expect(normalized.ciphertext).toBe(payload.ciphertext);
    expect(normalized.nonce).toBe(payload.nonce);
    expect(normalized.signature).toBe(payload.signature);
    expect(normalized.keys).toHaveLength(1);
  });

  it("accepts URL-safe base64 and canonicalizes it", () => {
    const payload = validPayload();
    const urlSafe = Buffer.from(payload.ciphertext, "base64").toString("base64url");
    const normalized = normalizeMessagePayload(
      { ...payload, ciphertext: urlSafe },
      options,
    );
    expect(normalized.ciphertext).toBe(payload.ciphertext);
  });

  it("rejects short ciphertext, wrong nonce and wrong signature size", () => {
    const payload = validPayload();
    expect(() =>
      normalizeMessagePayload({ ...payload, ciphertext: b64(16) }, options),
    ).toThrow(/ciphertext/);
    expect(() =>
      normalizeMessagePayload({ ...payload, nonce: b64(8) }, options),
    ).toThrow(/nonce/);
    expect(() =>
      normalizeMessagePayload({ ...payload, signature: b64(32) }, options),
    ).toThrow(/signature/);
  });

  it("rejects short wrapped keys and duplicate devices", () => {
    const payload = validPayload();
    const key = payload.keys[0];
    if (!key) throw new Error("missing key");
    expect(() =>
      normalizeMessagePayload(
        { ...payload, keys: [{ ...key, wrappedKey: b64(32) }] },
        options,
      ),
    ).toThrow(/wrappedKey/);
    expect(() =>
      normalizeMessagePayload({ ...payload, keys: [key, { ...key }] }, options),
    ).toThrow(/Duplicate device key/);
  });

  it("enforces ciphertext and envelope limits", () => {
    const payload = validPayload();
    try {
      normalizeMessagePayload(
        { ...payload, ciphertext: b64(2048) },
        { maxCiphertextBytes: 1024, maxEnvelopes: 10 },
      );
      throw new Error("expected payload too large");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(413);
    }

    const key = payload.keys[0];
    if (!key) throw new Error("missing key");
    expect(() =>
      normalizeMessagePayload(
        { ...payload, keys: [key, key].map((item, index) => ({
          ...item,
          deviceId: `1111111${index}-1111-4111-8111-111111111111`,
        })) },
        { maxCiphertextBytes: 1024, maxEnvelopes: 1 },
      ),
    ).toThrow(/At most 1/);
  });
});

describe("signed prekeys", () => {
  it("verifies a signed prekey and accepts X3DH envelope headers", async () => {
    const identity = createTestIdentity();
    const signed = generateKeyPairSync("x25519");
    const signedPreKeyPublicKey = signed.publicKey
      .export({ format: "jwk" })
      .x;
    if (!signedPreKeyPublicKey) throw new Error("missing signed prekey");
    const publicKey = Buffer.from(signedPreKeyPublicKey, "base64url").toString("base64");
    const id = randomUUID();
    const signature = sign(
      null,
      signedPreKeyMessage(id, publicKey),
      identity.signing.privateKey,
    ).toString("base64");

    const keys = normalizeDeviceKeys({
      identityPublicKey: identity.identity.publicKeyBase64,
      signingPublicKey: identity.signing.publicKeyBase64,
      signedPreKey: { id, publicKey, signature },
      oneTimePreKeys: [{ id: randomUUID(), publicKey }],
    });
    expect(keys.signedPreKey).toEqual({ id, publicKey, signature });
    expect(keys.oneTimePreKeys).toHaveLength(1);

    expect(() =>
      normalizeDeviceKeys({
        identityPublicKey: identity.identity.publicKeyBase64,
        signingPublicKey: identity.signing.publicKeyBase64,
        signedPreKey: { id, publicKey, signature: b64(64) },
      }),
    ).toThrow(AppError);

    const payload = validPayload();
    const oneTimePreKeyId = randomUUID();
    payload.keys = [
      {
        deviceId: "11111111-1111-4111-8111-111111111111",
        ratchetPublicKey: b64(32),
        previousChainLength: 0,
        messageNumber: 0,
        senderIdentityPublicKey: identity.identity.publicKeyBase64,
        signedPreKeyId: id,
        oneTimePreKeyId,
        wrappedKey: b64(48),
        wrapNonce: b64(12),
        version: 2,
      },
    ];
    const normalized = normalizeMessagePayload(payload, options);
    expect(normalized.keys[0]).toMatchObject({
      senderIdentityPublicKey: identity.identity.publicKeyBase64,
      signedPreKeyId: id,
      oneTimePreKeyId,
    });
  });
});

