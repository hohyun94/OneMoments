import { describe, expect, it } from "vitest";

import {
  DecryptionError,
  createIdentityWithBackend,
  decryptMessage,
  encryptMessage,
  fromBase64,
  type DecryptableMessage,
  type IdentityBackend,
  type RecipientDevice,
} from "./crypto/index.ts";
import { detectBackend } from "./crypto/keys.ts";
import { toBase64 } from "./crypto/encoding.ts";

async function availableBackends(): Promise<IdentityBackend[]> {
  const detected = await detectBackend();
  return detected === "webcrypto" ? ["noble", "webcrypto"] : ["noble"];
}

function tamperBase64(value: string): string {
  const bytes = fromBase64(value);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return toBase64(bytes);
}

describe("client crypto envelope", () => {
  it("round-trips messages for every available backend", async () => {
    const backends = await availableBackends();
    for (const backend of backends) {
      const alice = await createIdentityWithBackend(backend);
      const bob = await createIdentityWithBackend(backend);
      const conversationId = crypto.randomUUID();
      const clientMessageId = crypto.randomUUID();
      const recipients: RecipientDevice[] = [
        { deviceId: "device-alice", identityPublicKey: alice.identityPublicKey },
        { deviceId: "device-bob", identityPublicKey: bob.identityPublicKey },
      ];

      const payload = await encryptMessage({
        identity: alice,
        conversationId,
        clientMessageId,
        plaintext: "안녕하세요, OneMoments!",
        recipients,
      });
      expect(payload.keys).toHaveLength(2);

      const base = {
        conversationId,
        clientMessageId,
        ciphertext: payload.ciphertext,
        nonce: payload.nonce,
        signature: payload.signature,
        senderSigningPublicKey: alice.signingPublicKey,
      };

      const bobKey = payload.keys.find((key) => key.deviceId === "device-bob");
      const aliceKey = payload.keys.find((key) => key.deviceId === "device-alice");
      expect(bobKey).toBeDefined();
      expect(aliceKey).toBeDefined();

      await expect(
        decryptMessage({
          identity: bob,
          message: { ...base, key: bobKey as DecryptableMessage["key"] },
        }),
      ).resolves.toBe("안녕하세요, OneMoments!");

      await expect(
        decryptMessage({
          identity: alice,
          message: { ...base, key: aliceKey as DecryptableMessage["key"] },
        }),
      ).resolves.toBe("안녕하세요, OneMoments!");
    }
  });

  it("interoperates between noble and webcrypto identities", async () => {
    const detected = await detectBackend();
    if (detected !== "webcrypto") return;

    const alice = await createIdentityWithBackend("noble");
    const bob = await createIdentityWithBackend("webcrypto");
    const conversationId = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();
    const payload = await encryptMessage({
      identity: alice,
      conversationId,
      clientMessageId,
      plaintext: "cross backend",
      recipients: [{ deviceId: "bob", identityPublicKey: bob.identityPublicKey }],
    });
    const key = payload.keys[0];
    if (!key) throw new Error("missing key");

    await expect(
      decryptMessage({
        identity: bob,
        message: {
          conversationId,
          clientMessageId,
          ciphertext: payload.ciphertext,
          nonce: payload.nonce,
          signature: payload.signature,
          senderSigningPublicKey: alice.signingPublicKey,
          key,
        },
      }),
    ).resolves.toBe("cross backend");
  });

  it("rejects messages encrypted for another device", async () => {
    const alice = await createIdentityWithBackend("noble");
    const bob = await createIdentityWithBackend("noble");
    const carol = await createIdentityWithBackend("noble");
    const conversationId = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();
    const payload = await encryptMessage({
      identity: alice,
      conversationId,
      clientMessageId,
      plaintext: "secret",
      recipients: [
        { deviceId: "alice", identityPublicKey: alice.identityPublicKey },
        { deviceId: "bob", identityPublicKey: bob.identityPublicKey },
      ],
    });
    const bobKey = payload.keys.find((key) => key.deviceId === "bob");
    if (!bobKey) throw new Error("missing key");

    await expect(
      decryptMessage({
        identity: carol,
        message: {
          conversationId,
          clientMessageId,
          ciphertext: payload.ciphertext,
          nonce: payload.nonce,
          signature: payload.signature,
          senderSigningPublicKey: alice.signingPublicKey,
          key: bobKey,
        },
      }),
    ).rejects.toMatchObject({ reason: "key" });
  });

  it("detects ciphertext and signature tampering", async () => {
    const alice = await createIdentityWithBackend("noble");
    const bob = await createIdentityWithBackend("noble");
    const conversationId = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();
    const payload = await encryptMessage({
      identity: alice,
      conversationId,
      clientMessageId,
      plaintext: "tamper me",
      recipients: [{ deviceId: "bob", identityPublicKey: bob.identityPublicKey }],
    });
    const key = payload.keys[0];
    if (!key) throw new Error("missing key");

    const base = {
      conversationId,
      clientMessageId,
      nonce: payload.nonce,
      senderSigningPublicKey: alice.signingPublicKey,
      key,
      ciphertext: payload.ciphertext,
      signature: payload.signature,
    };

    try {
      await decryptMessage({
        identity: bob,
        message: { ...base, ciphertext: tamperBase64(payload.ciphertext) },
      });
      throw new Error("expected ciphertext failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DecryptionError);
      expect(["ciphertext", "signature"]).toContain((error as DecryptionError).reason);
    }

    try {
      await decryptMessage({
        identity: bob,
        message: { ...base, signature: tamperBase64(payload.signature) },
      });
      throw new Error("expected signature failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DecryptionError);
      expect((error as DecryptionError).reason).toBe("signature");
    }
  });
});
