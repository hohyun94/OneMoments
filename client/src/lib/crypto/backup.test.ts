import { describe, expect, it } from "vitest";

import {
  BackupError,
  createIdentityWithBackend,
  decryptMessage,
  encryptMessage,
  exportKeyBackup,
  importKeyBackup,
  type IdentityBackend,
  type KeyBackupBlob,
} from "./index.ts";
import { detectBackend, type DeviceIdentity } from "./keys.ts";
import { fromBase64, toBase64 } from "./encoding.ts";

const PASSPHRASE = "correct horse recovery battery";

async function backends(): Promise<IdentityBackend[]> {
  return (await detectBackend()) === "webcrypto"
    ? ["noble", "webcrypto"]
    : ["noble"];
}

function withDevice(identity: DeviceIdentity): DeviceIdentity {
  return { ...identity, deviceId: "11111111-1111-4111-8111-111111111111" };
}

function tamper(blob: KeyBackupBlob): KeyBackupBlob {
  const bytes = fromBase64(blob.ciphertext);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return { ...blob, ciphertext: toBase64(bytes) };
}

describe("encrypted key backup", () => {
  it("round-trips identity keys for every backend", async () => {
    for (const backend of await backends()) {
      const identity = withDevice(await createIdentityWithBackend(backend));
      const blob = await exportKeyBackup(identity, PASSPHRASE);
      const restored = await importKeyBackup(blob, PASSPHRASE);

      expect(restored.backend).toBe(identity.backend);
      expect(restored.deviceId).toBe(identity.deviceId);
      expect(restored.identityPublicKey).toBe(identity.identityPublicKey);
      expect(restored.signingPublicKey).toBe(identity.signingPublicKey);

      const sender = withDevice(await createIdentityWithBackend("noble"));
      const payload = await encryptMessage({
        identity: sender,
        conversationId: "conversation-1",
        clientMessageId: "backup-1",
        plaintext: "복구된 키로 읽는 메시지",
        recipients: [
          { deviceId: "restored", identityPublicKey: restored.identityPublicKey },
        ],
      });
      const key = payload.keys[0];
      if (!key) throw new Error("missing key");
      await expect(
        decryptMessage({
          identity: restored,
          message: {
            conversationId: "conversation-1",
            clientMessageId: "backup-1",
            ciphertext: payload.ciphertext,
            nonce: payload.nonce,
            signature: payload.signature,
            senderSigningPublicKey: sender.signingPublicKey,
            key,
          },
        }),
      ).resolves.toBe("복구된 키로 읽는 메시지");
    }
  });

  it("rejects a wrong passphrase and tampered ciphertext", async () => {
    const identity = withDevice(await createIdentityWithBackend("noble"));
    const blob = await exportKeyBackup(identity, PASSPHRASE);

    await expect(importKeyBackup(blob, "wrong passphrase")).rejects.toMatchObject({
      reason: "passphrase",
    });
    await expect(importKeyBackup(tamper(blob), PASSPHRASE)).rejects.toMatchObject({
      reason: "passphrase",
    });
  });

  it("round-trips the local ratchet state", async () => {
    const identity = withDevice(await createIdentityWithBackend("noble"));
    const state = {
      sessions: [
        {
          version: 1 as const,
          conversationId: "conversation-state",
          localDeviceId: identity.deviceId as string,
          remoteDeviceId: "remote-device",
          dhSelfPrivate: "private",
          dhSelfPublic: "public",
          dhRemote: "remote",
          rootKey: "root",
          sendChainKey: "send",
          recvChainKey: "recv",
          sendCount: 3,
          recvCount: 2,
          previousSendCount: 0,
          skipped: { "remote:0": "key" },
        },
      ],
      historyKeys: [
        {
          deviceId: identity.deviceId as string,
          messageId: "message-1",
          key: "message-key",
          savedAt: 123,
        },
      ],
    };

    const blob = await exportKeyBackup(identity, PASSPHRASE, state);
    const restored = await importKeyBackup(blob, PASSPHRASE);
    expect(restored.state).toEqual(state);
  });

  it("rejects identities without a device id", async () => {
    const identity = await createIdentityWithBackend("noble");
    await expect(exportKeyBackup(identity, PASSPHRASE)).rejects.toBeInstanceOf(
      BackupError,
    );
  });
});
