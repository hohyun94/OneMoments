import { describe, expect, it } from "vitest";

import {
  commitSenderKeyMessage,
  createIdentityWithBackend,
  decryptMessage,
  prepareSenderKeyMessage,
  rememberHistoryKey,
  type DeviceKeyEnvelope,
  type PreparedSenderKeyMessage,
} from "./index.ts";

function withDevice<T extends { deviceId?: string }>(identity: T, deviceId: string): T {
  return { ...identity, deviceId };
}

function messageFor(input: {
  prepared: PreparedSenderKeyMessage;
  key: DeviceKeyEnvelope | null;
  conversationId: string;
  senderDeviceId: string;
  senderSigningPublicKey: string;
  messageId: string;
}) {
  return {
    id: input.messageId,
    conversationId: input.conversationId,
    clientMessageId: input.prepared.payload.clientMessageId,
    ciphertext: input.prepared.payload.ciphertext,
    nonce: input.prepared.payload.nonce,
    signature: input.prepared.payload.signature,
    senderDeviceId: input.senderDeviceId,
    senderSigningPublicKey: input.senderSigningPublicKey,
    senderKeyId: input.prepared.payload.senderKeyId,
    senderKeyIteration: input.prepared.payload.senderKeyIteration,
    key: input.key,
  };
}

describe("sender keys", () => {
  it("distributes once and then sends group messages without envelopes", async () => {
    const alice = withDevice(await createIdentityWithBackend("noble"), "sk-alice");
    const bob = withDevice(await createIdentityWithBackend("noble"), "sk-bob");
    const carol = withDevice(await createIdentityWithBackend("noble"), "sk-carol");
    const conversationId = crypto.randomUUID();
    const devices = [bob, carol].map((identity) => ({
      deviceId: identity.deviceId as string,
      identityPublicKey: identity.identityPublicKey,
      signedPreKeyId: identity.signedPreKeyId,
      signedPreKeyPublicKey: identity.signedPreKeyPublicKey,
    }));

    const first = await prepareSenderKeyMessage({
      identity: alice,
      conversationId,
      clientMessageId: "sk-1",
      plaintext: "첫 그룹 메시지",
      devices,
    });
    expect(first.payload.keys).toHaveLength(2);
    expect(first.payload.keys.every((key) => key.distribution !== undefined)).toBe(true);
    await commitSenderKeyMessage(first);

    const bobKey = first.payload.keys.find((key) => key.deviceId === "sk-bob");
    if (!bobKey) throw new Error("missing bob distribution");
    const firstMessage = messageFor({
      prepared: first,
      key: bobKey,
      conversationId,
      senderDeviceId: "sk-alice",
      senderSigningPublicKey: alice.signingPublicKey,
      messageId: "m1",
    });
    await expect(decryptMessage({ identity: bob, message: firstMessage })).resolves.toBe(
      "첫 그룹 메시지",
    );
    await expect(decryptMessage({ identity: bob, message: firstMessage })).resolves.toBe(
      "첫 그룹 메시지",
    );

    const second = await prepareSenderKeyMessage({
      identity: alice,
      conversationId,
      clientMessageId: "sk-2",
      plaintext: "두 번째 그룹 메시지",
      devices,
    });
    expect(second.payload.keys).toHaveLength(0);
    await commitSenderKeyMessage(second);
    await expect(
      decryptMessage({
        identity: bob,
        message: messageFor({
          prepared: second,
          key: null,
          conversationId,
          senderDeviceId: "sk-alice",
          senderSigningPublicKey: alice.signingPublicKey,
          messageId: "m2",
        }),
      }),
    ).resolves.toBe("두 번째 그룹 메시지");

    const third = await prepareSenderKeyMessage({
      identity: alice,
      conversationId,
      clientMessageId: "sk-3",
      plaintext: "세 번째",
      devices,
    });
    await commitSenderKeyMessage(third);
    const fourth = await prepareSenderKeyMessage({
      identity: alice,
      conversationId,
      clientMessageId: "sk-4",
      plaintext: "네 번째",
      devices,
    });
    await commitSenderKeyMessage(fourth);

    await expect(
      decryptMessage({
        identity: bob,
        message: messageFor({
          prepared: fourth,
          key: null,
          conversationId,
          senderDeviceId: "sk-alice",
          senderSigningPublicKey: alice.signingPublicKey,
          messageId: "m4",
        }),
      }),
    ).resolves.toBe("네 번째");
    await expect(
      decryptMessage({
        identity: bob,
        message: messageFor({
          prepared: third,
          key: null,
          conversationId,
          senderDeviceId: "sk-alice",
          senderSigningPublicKey: alice.signingPublicKey,
          messageId: "m3",
        }),
      }),
    ).resolves.toBe("세 번째");
  });


  it("distributes to a device that joins later", async () => {
    const alice = withDevice(await createIdentityWithBackend("noble"), "late-alice");
    const bob = withDevice(await createIdentityWithBackend("noble"), "late-bob");
    const dave = withDevice(await createIdentityWithBackend("noble"), "late-dave");
    const conversationId = crypto.randomUUID();

    const first = await prepareSenderKeyMessage({
      identity: alice,
      conversationId,
      clientMessageId: "late-1",
      plaintext: "기존 참여자",
      devices: [{ deviceId: "late-bob", identityPublicKey: bob.identityPublicKey }],
    });
    await commitSenderKeyMessage(first);

    const second = await prepareSenderKeyMessage({
      identity: alice,
      conversationId,
      clientMessageId: "late-2",
      plaintext: "새 참여자",
      devices: [
        { deviceId: "late-bob", identityPublicKey: bob.identityPublicKey },
        { deviceId: "late-dave", identityPublicKey: dave.identityPublicKey },
      ],
    });
    expect(second.payload.keys).toHaveLength(1);
    expect(second.payload.keys[0]?.deviceId).toBe("late-dave");
    await commitSenderKeyMessage(second);

    await expect(
      decryptMessage({
        identity: dave,
        message: messageFor({
          prepared: second,
          key: second.payload.keys[0] ?? null,
          conversationId,
          senderDeviceId: "late-alice",
          senderSigningPublicKey: alice.signingPublicKey,
          messageId: "late-m2",
        }),
      }),
    ).resolves.toBe("새 참여자");
  });

  it("reads the sender's own message from the saved history key", async () => {
    const alice = withDevice(await createIdentityWithBackend("noble"), "self-alice");
    const bob = withDevice(await createIdentityWithBackend("noble"), "self-bob");
    const conversationId = crypto.randomUUID();
    const prepared = await prepareSenderKeyMessage({
      identity: alice,
      conversationId,
      clientMessageId: "self-1",
      plaintext: "내가 보낸 그룹 메시지",
      devices: [{ deviceId: "self-bob", identityPublicKey: bob.identityPublicKey }],
    });
    await commitSenderKeyMessage(prepared);
    await rememberHistoryKey({
      deviceId: alice.deviceId,
      messageId: "self-m1",
      messageKey: prepared.messageKey,
    });

    await expect(
      decryptMessage({
        identity: alice,
        message: messageFor({
          prepared,
          key: null,
          conversationId,
          senderDeviceId: "self-alice",
          senderSigningPublicKey: alice.signingPublicKey,
          messageId: "self-m1",
        }),
      }),
    ).resolves.toBe("내가 보낸 그룹 메시지");
  });
});

