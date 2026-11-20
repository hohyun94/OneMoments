import {
  aesDecrypt,
  aesEncrypt,
  deriveKek,
  deriveShared,
  generateEphemeral,
  importContentKey,
  randomBytes,
  signPayload,
  signaturePayload,
  verifyPayload,
  type DeviceIdentity,
} from "./keys.ts";
import { decoder, fromBase64, toBase64 } from "./encoding.ts";
import { padPlaintext, unpadPlaintext } from "./padding.ts";
import {
  decryptWithMessageKey,
  findHistoryKey,
  rememberHistoryKey,
  unwrapContentKey,
  wrapContentKey,
  RATCHET_VERSION,
  RatchetError,
} from "./ratchet.ts";
import {
  decryptSenderKeyMessage,
  SenderKeyError,
} from "./senderKey.ts";

export interface RecipientDevice {
  deviceId: string;
  identityPublicKey: string;
  signedPreKeyId?: string | null;
  signedPreKeyPublicKey?: string | null;
  oneTimePreKeyId?: string | null;
  oneTimePreKeyPublicKey?: string | null;
}

export type DeviceKeyEnvelope =
  | {
      deviceId: string;
      ephemeralPublicKey: string;
      wrappedKey: string;
      wrapNonce: string;
      version: 1;
      distribution?: { ciphertext: string; nonce: string };
    }
  | {
      deviceId: string;
      ratchetPublicKey: string;
      previousChainLength: number;
      messageNumber: number;
      senderIdentityPublicKey?: string;
      signedPreKeyId?: string;
      oneTimePreKeyId?: string;
      wrappedKey: string;
      wrapNonce: string;
      version: 2;
      distribution?: { ciphertext: string; nonce: string };
    };

export interface EncryptedPayload {
  clientMessageId: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  keys: DeviceKeyEnvelope[];
}

export type DecryptableKeyEnvelope = DeviceKeyEnvelope;

export interface DecryptableMessage {
  id?: string;
  conversationId: string;
  clientMessageId: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  senderUserId?: string;
  senderDeviceId?: string;
  senderSigningPublicKey: string;
  senderKeyId?: string | null;
  senderKeyIteration?: number | null;
  key: DecryptableKeyEnvelope | null;
}

export type DecryptionFailure = "key" | "ciphertext" | "signature";

export class DecryptionError extends Error {
  constructor(readonly reason: DecryptionFailure) {
    super(`Unable to decrypt message: ${reason}`);
    this.name = "DecryptionError";
  }
}

const VERSION = 1 as const;

/**
 * 콘텐츠 키 1개로 평문을 암호화하고, 수신 기기마다 X25519 봉투를 만든다.
 * 서명은 (conversationId, clientMessageId, sha256(ciphertext)) 에 대한 Ed25519 다.
 */
export async function encryptMessage(input: {
  identity: DeviceIdentity;
  conversationId: string;
  clientMessageId: string;
  plaintext: string;
  recipients: RecipientDevice[];
}): Promise<EncryptedPayload> {
  if (input.recipients.length === 0) {
    throw new Error("No recipient devices");
  }

  const contentKeyRaw = randomBytes(32);
  const contentKey = await importContentKey(contentKeyRaw);
  const nonce = randomBytes(12);
  const ciphertext = await aesEncrypt(
    contentKey,
    nonce,
    new TextEncoder().encode(padPlaintext(input.plaintext)),
  );
  const ciphertextBase64 = toBase64(ciphertext);

  const signature = await signPayload(
    input.identity.backend,
    input.identity.signingPrivate,
    await signaturePayload(
      input.conversationId,
      input.clientMessageId,
      ciphertextBase64,
    ),
  );

  const keys: DeviceKeyEnvelope[] = [];
  for (const recipient of input.recipients) {
    if (
      (input.identity.deviceId && recipient.deviceId === input.identity.deviceId) ||
      recipient.identityPublicKey === input.identity.identityPublicKey
    ) {
      // 발신자 자신의 기기는 즉시 복호화할 수 있도록 기존 정적 키 봉투를 쓴다.
      const ephemeral = await generateEphemeral(input.identity.backend);
      const shared = await deriveShared(
        input.identity.backend,
        ephemeral.privateKey,
        recipient.identityPublicKey,
      );
      const kek = await deriveKek(shared);
      const wrapNonce = randomBytes(12);
      const wrappedKey = await aesEncrypt(kek, wrapNonce, contentKeyRaw);
      keys.push({
        deviceId: recipient.deviceId,
        ephemeralPublicKey: ephemeral.publicKey,
        wrappedKey: toBase64(wrappedKey),
        wrapNonce: toBase64(wrapNonce),
        version: VERSION,
      });
      continue;
    }

    const wrapped = await wrapContentKey({
      identity: input.identity,
      conversationId: input.conversationId,
      remoteDeviceId: recipient.deviceId,
      remoteIdentityPublicKey: recipient.identityPublicKey,
      remoteSignedPreKeyId: recipient.signedPreKeyId,
      remoteSignedPreKeyPublicKey: recipient.signedPreKeyPublicKey,
      remoteOneTimePreKeyId: recipient.oneTimePreKeyId,
      remoteOneTimePreKeyPublicKey: recipient.oneTimePreKeyPublicKey,
      contentKey: contentKeyRaw,
    });
    keys.push({ deviceId: recipient.deviceId, ...wrapped });
  }

  return {
    clientMessageId: input.clientMessageId,
    ciphertext: ciphertextBase64,
    nonce: toBase64(nonce),
    signature: toBase64(signature),
    keys,
  };
}

async function verifyMessageSignature(
  identity: DeviceIdentity,
  message: DecryptableMessage,
): Promise<boolean> {
  return verifyPayload(
    identity.backend,
    message.senderSigningPublicKey,
    await signaturePayload(
      message.conversationId,
      message.clientMessageId,
      message.ciphertext,
    ),
    fromBase64(message.signature),
  );
}

export async function decryptMessage(input: {
  identity: DeviceIdentity;
  message: DecryptableMessage;
}): Promise<string> {
  const { identity, message } = input;

  if (message.senderKeyId) {
    try {
      return await decryptSenderKeyMessage({
        identity,
        message: {
          id: message.id,
          conversationId: message.conversationId,
          clientMessageId: message.clientMessageId,
          ciphertext: message.ciphertext,
          nonce: message.nonce,
          signature: message.signature,
          senderDeviceId: message.senderDeviceId,
          senderSigningPublicKey: message.senderSigningPublicKey,
          senderKeyId: message.senderKeyId,
          senderKeyIteration: message.senderKeyIteration ?? 0,
          key: message.key,
        },
      });
    } catch (error) {
      if (error instanceof SenderKeyError && error.reason === "signature") {
        throw new DecryptionError("signature");
      }
      throw new DecryptionError("key");
    }
  }

  const key = message.key;
  if (!key) throw new DecryptionError("key");
  const isRatchet = key.version === RATCHET_VERSION;

  // v2는 서명을 먼저 확인해 변조 메시지가 ratchet 상태를 소모하지 않게 한다.
  if (isRatchet && !(await verifyMessageSignature(identity, message))) {
    throw new DecryptionError("signature");
  }

  let contentKeyRaw: Uint8Array<ArrayBuffer>;
  let newHistoryKey: string | null = null;

  if (key.version === RATCHET_VERSION) {
    const historyKey = await findHistoryKey(identity.deviceId, message.id);
    if (historyKey) {
      try {
        contentKeyRaw = await decryptWithMessageKey({
          messageKey: historyKey,
          wrappedKey: key.wrappedKey,
          wrapNonce: key.wrapNonce,
        });
      } catch {
        throw new DecryptionError("key");
      }
    } else {
      try {
        const result = await unwrapContentKey({
          identity,
          conversationId: message.conversationId,
          senderDeviceId: message.senderDeviceId ?? "unknown",
          header: {
            ratchetPublicKey: key.ratchetPublicKey,
            previousChainLength: key.previousChainLength,
            messageNumber: key.messageNumber,
            ...(key.senderIdentityPublicKey && key.signedPreKeyId
              ? {
                  senderIdentityPublicKey: key.senderIdentityPublicKey,
                  signedPreKeyId: key.signedPreKeyId,
                  ...(key.oneTimePreKeyId
                    ? { oneTimePreKeyId: key.oneTimePreKeyId }
                    : {}),
                }
              : {}),
          },
          wrappedKey: key.wrappedKey,
          wrapNonce: key.wrapNonce,
        });
        contentKeyRaw = result.contentKey;
        newHistoryKey = result.messageKey;
      } catch (error) {
        if (error instanceof RatchetError) throw new DecryptionError("key");
        throw new DecryptionError("key");
      }
    }
  } else {
    try {
      const shared = await deriveShared(
        identity.backend,
        identity.identityPrivate,
        key.ephemeralPublicKey,
      );
      const kek = await deriveKek(shared);
      contentKeyRaw = await aesDecrypt(
        kek,
        fromBase64(key.wrapNonce),
        fromBase64(key.wrappedKey),
      );
    } catch {
      throw new DecryptionError("key");
    }
  }

  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    const contentKey = await importContentKey(contentKeyRaw);
    plaintext = await aesDecrypt(
      contentKey,
      fromBase64(message.nonce),
      fromBase64(message.ciphertext),
    );
  } catch {
    throw new DecryptionError("ciphertext");
  }

  if (!isRatchet && !(await verifyMessageSignature(identity, message))) {
    throw new DecryptionError("signature");
  }

  if (newHistoryKey) {
    await rememberHistoryKey({
      deviceId: identity.deviceId,
      messageId: message.id,
      messageKey: newHistoryKey,
    });
  }

  return unpadPlaintext(decoder.decode(plaintext));
}
