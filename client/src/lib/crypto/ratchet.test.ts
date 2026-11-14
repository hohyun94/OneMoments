import { describe, expect, it } from "vitest";

import {
  createIdentityWithBackend,
  decryptMessage,
  encryptMessage,
  fromBase64,
  toBase64,
  type DecryptableMessage,
  type DeviceKeyEnvelope,
  type EncryptedPayload,
  type IdentityBackend,
} from "./index.ts";
import { detectBackend } from "./keys.ts";

function withDevice<T extends { deviceId?: string }>(identity: T, deviceId: string): T {
  return { ...identity, deviceId };
}

function keyFor(payload: EncryptedPayload, deviceId: string): DeviceKeyEnvelope {
  const key = payload.keys.find((candidate) => candidate.deviceId === deviceId);
  if (!key) throw new Error(`missing key for ${deviceId}`);
  return key;
}

function message(input: {
  payload: EncryptedPayload;
  key: DeviceKeyEnvelope;
  conversationId: string;
  senderSigningPublicKey: string;
  senderDeviceId: string;
  messageId: string;
}): DecryptableMessage {
  return {
    id: input.messageId,
    conversationId: input.conversationId,
    clientMessageId: input.payload.clientMessageId,
    ciphertext: input.payload.ciphertext,
    nonce: input.payload.nonce,
    signature: input.payload.signature,
    senderDeviceId: input.senderDeviceId,
    senderSigningPublicKey: input.senderSigningPublicKey,
    key: input.key,
  };
}

async function backends(): Promise<IdentityBackend[]> {
  return (await detectBackend()) === "webcrypto" ? ["noble", "webcrypto"] : ["noble"];
}

describe("double ratchet", () => {
  it("ratchets in both directions and restores history keys", async () => {
    for (const backend of await backends()) {
      const suffix = backend;
      const alice = withDevice(
        await createIdentityWithBackend(backend),
        `alice-device-${suffix}`,
      );
      const bob = withDevice(await createIdentityWithBackend(backend), `bob-device-${suffix}`);
      const conversationId = crypto.randomUUID();
      const recipients = [
        {
          deviceId: `alice-device-${suffix}`,
          identityPublicKey: alice.identityPublicKey,
        },
        { deviceId: `bob-device-${suffix}`, identityPublicKey: bob.identityPublicKey },
      ];

      const first = await encryptMessage({
        identity: alice,
        conversationId,
        clientMessageId: "first",
        plaintext: "첫 메시지",
        recipients,
      });
      const firstKey = keyFor(first, `bob-device-${suffix}`);
      expect(firstKey.version).toBe(2);
      const firstMessage = message({
        payload: first,
        key: firstKey,
        conversationId,
        senderSigningPublicKey: alice.signingPublicKey,
        senderDeviceId: `alice-device-${suffix}`,
        messageId: `m1-${suffix}`,
      });

      await expect(decryptMessage({ identity: bob, message: firstMessage })).resolves.toBe(
        "첫 메시지",
      );
      // 새로고침 대응: 저장된 이력 키로 같은 메시지를 다시 복호화한다.
      await expect(decryptMessage({ identity: bob, message: firstMessage })).resolves.toBe(
        "첫 메시지",
      );

      const reply = await encryptMessage({
        identity: bob,
        conversationId,
        clientMessageId: "reply",
        plaintext: "답장",
        recipients,
      });
      await expect(
        decryptMessage({
          identity: alice,
          message: message({
            payload: reply,
            key: keyFor(reply, `alice-device-${suffix}`),
            conversationId,
            senderSigningPublicKey: bob.signingPublicKey,
            senderDeviceId: `bob-device-${suffix}`,
            messageId: `m2-${suffix}`,
          }),
        }),
      ).resolves.toBe("답장");

      const third = await encryptMessage({
        identity: alice,
        conversationId,
        clientMessageId: "third",
        plaintext: "다시 보냄",
        recipients,
      });
      await expect(
        decryptMessage({
          identity: bob,
          message: message({
            payload: third,
            key: keyFor(third, `bob-device-${suffix}`),
            conversationId,
            senderSigningPublicKey: alice.signingPublicKey,
            senderDeviceId: `alice-device-${suffix}`,
            messageId: `m3-${suffix}`,
          }),
        }),
      ).resolves.toBe("다시 보냄");
    }
  });


  it("handles out-of-order messages with skipped keys", async () => {
    const alice = withDevice(await createIdentityWithBackend("noble"), "alice-device");
    const bob = withDevice(await createIdentityWithBackend("noble"), "bob-device");
    const conversationId = crypto.randomUUID();
    const recipients = [
      { deviceId: "alice-device", identityPublicKey: alice.identityPublicKey },
      { deviceId: "bob-device", identityPublicKey: bob.identityPublicKey },
    ];

    const payloads: EncryptedPayload[] = [];
    for (const index of [1, 2, 3]) {
      payloads.push(
        await encryptMessage({
          identity: alice,
          conversationId,
          clientMessageId: `m${index}`,
          plaintext: `메시지 ${index}`,
          recipients,
        }),
      );
    }

    for (const index of [3, 1, 2]) {
      const payload = payloads[index - 1];
      if (!payload) throw new Error("missing payload");
      const decrypted = await decryptMessage({
        identity: bob,
        message: message({
          payload,
          key: keyFor(payload, "bob-device"),
          conversationId,
          senderSigningPublicKey: alice.signingPublicKey,
          senderDeviceId: "alice-device",
          messageId: `out-${index}`,
        }),
      });
      expect(decrypted).toBe(`메시지 ${index}`);
    }
  });

  it("does not consume ratchet state for tampered messages", async () => {
    const alice = withDevice(await createIdentityWithBackend("noble"), "alice-device");
    const bob = withDevice(await createIdentityWithBackend("noble"), "bob-device");
    const conversationId = crypto.randomUUID();
    const recipients = [
      { deviceId: "alice-device", identityPublicKey: alice.identityPublicKey },
      { deviceId: "bob-device", identityPublicKey: bob.identityPublicKey },
    ];
    const payload = await encryptMessage({
      identity: alice,
      conversationId,
      clientMessageId: "tamper",
      plaintext: "변조 테스트",
      recipients,
    });
    const key = keyFor(payload, "bob-device");
    const base = message({
      payload,
      key,
      conversationId,
      senderSigningPublicKey: alice.signingPublicKey,
      senderDeviceId: "alice-device",
      messageId: "tampered",
    });
    const ciphertext = fromBase64(payload.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;

    await expect(
      decryptMessage({
        identity: bob,
        message: { ...base, ciphertext: toBase64(ciphertext) },
      }),
    ).rejects.toBeInstanceOf(Error);

    await expect(
      decryptMessage({
        identity: bob,
        message: { ...base, ciphertext: payload.ciphertext },
      }),
    ).resolves.toBe("변조 테스트");
  });

  it("initializes v2 with X3DH when a signed prekey is available", async () => {
    for (const backend of await backends()) {
      const suffix = backend;
      const alice = withDevice(
        await createIdentityWithBackend(backend),
        `x3dh-alice-${suffix}`,
      );
      const bob = withDevice(await createIdentityWithBackend(backend), `x3dh-bob-${suffix}`);
      const conversationId = crypto.randomUUID();
      const recipients = [
        {
          deviceId: `x3dh-bob-${suffix}`,
          identityPublicKey: bob.identityPublicKey,
          signedPreKeyId: bob.signedPreKeyId,
          signedPreKeyPublicKey: bob.signedPreKeyPublicKey,
        },
      ];

      const payload = await encryptMessage({
        identity: alice,
        conversationId,
        clientMessageId: "x3dh-first",
        plaintext: "X3DH 메시지",
        recipients,
      });
      const bobKey = keyFor(payload, `x3dh-bob-${suffix}`);
      expect(bobKey.version).toBe(2);
      if (bobKey.version !== 2) throw new Error("expected v2 envelope");
      expect(bobKey.senderIdentityPublicKey).toBe(alice.identityPublicKey);
      expect(bobKey.signedPreKeyId).toBe(bob.signedPreKeyId);

      await expect(
        decryptMessage({
          identity: bob,
          message: message({
            payload,
            key: bobKey,
            conversationId,
            senderSigningPublicKey: alice.signingPublicKey,
            senderDeviceId: `x3dh-alice-${suffix}`,
            messageId: `x3dh-m1-${suffix}`,
          }),
        }),
      ).resolves.toBe("X3DH 메시지");

      const reply = await encryptMessage({
        identity: bob,
        conversationId,
        clientMessageId: "x3dh-reply",
        plaintext: "X3DH 답장",
        recipients: [
          {
            deviceId: `x3dh-alice-${suffix}`,
            identityPublicKey: alice.identityPublicKey,
            signedPreKeyId: alice.signedPreKeyId,
            signedPreKeyPublicKey: alice.signedPreKeyPublicKey,
          },
        ],
      });
      await expect(
        decryptMessage({
          identity: alice,
          message: message({
            payload: reply,
            key: keyFor(reply, `x3dh-alice-${suffix}`),
            conversationId,
            senderSigningPublicKey: bob.signingPublicKey,
            senderDeviceId: `x3dh-bob-${suffix}`,
            messageId: `x3dh-m2-${suffix}`,
          }),
        }),
      ).resolves.toBe("X3DH 답장");
    }
  });

});

