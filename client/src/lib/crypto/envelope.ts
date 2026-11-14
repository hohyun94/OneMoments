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

export interface RecipientDevice {
  deviceId: string;
  identityPublicKey: string;
}

export interface DeviceKeyEnvelope {
  deviceId: string;
  ephemeralPublicKey: string;
  wrappedKey: string;
  wrapNonce: string;
  version: 1;
}

export interface EncryptedPayload {
  clientMessageId: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  keys: DeviceKeyEnvelope[];
}

export interface DecryptableMessage {
  conversationId: string;
  clientMessageId: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  senderSigningPublicKey: string;
  key: {
    ephemeralPublicKey: string;
    wrappedKey: string;
    wrapNonce: string;
  };
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
    new TextEncoder().encode(input.plaintext),
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
  }

  return {
    clientMessageId: input.clientMessageId,
    ciphertext: ciphertextBase64,
    nonce: toBase64(nonce),
    signature: toBase64(signature),
    keys,
  };
}

export async function decryptMessage(input: {
  identity: DeviceIdentity;
  message: DecryptableMessage;
}): Promise<string> {
  const { identity, message } = input;

  let contentKeyRaw: Uint8Array<ArrayBuffer>;
  try {
    const shared = await deriveShared(
      identity.backend,
      identity.identityPrivate,
      message.key.ephemeralPublicKey,
    );
    const kek = await deriveKek(shared);
    contentKeyRaw = await aesDecrypt(
      kek,
      fromBase64(message.key.wrapNonce),
      fromBase64(message.key.wrappedKey),
    );
  } catch {
    throw new DecryptionError("key");
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

  const verified = await verifyPayload(
    identity.backend,
    message.senderSigningPublicKey,
    await signaturePayload(
      message.conversationId,
      message.clientMessageId,
      message.ciphertext,
    ),
    fromBase64(message.signature),
  );
  if (!verified) throw new DecryptionError("signature");

  return decoder.decode(plaintext);
}
