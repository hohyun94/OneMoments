import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface Identity {
  identity: { privateKey: KeyObject; publicKey: KeyObject; publicKeyBase64: string };
  signing: { privateKey: KeyObject; publicKey: KeyObject; publicKeyBase64: string };
}

function rawPublicKeyBase64(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const raw = Buffer.from(jwk.x ?? "", "base64url");
  if (raw.length !== 32) throw new Error("Unexpected public key length");
  return raw.toString("base64");
}

export function x25519PublicKeyFromBase64(value: string): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(value, "base64")]),
    format: "der",
    type: "spki",
  });
}

export function ed25519PublicKeyFromBase64(value: string): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(value, "base64")]),
    format: "der",
    type: "spki",
  });
}

export function createIdentity(): Identity {
  const identity = generateKeyPairSync("x25519");
  const signing = generateKeyPairSync("ed25519");
  return {
    identity: {
      privateKey: identity.privateKey,
      publicKey: identity.publicKey,
      publicKeyBase64: rawPublicKeyBase64(identity.publicKey),
    },
    signing: {
      privateKey: signing.privateKey,
      publicKey: signing.publicKey,
      publicKeyBase64: rawPublicKeyBase64(signing.publicKey),
    },
  };
}

/** 봉투 규격: X25519 ECDH → HKDF-SHA256(info="onemoments/v1/wrap") → AES 키 */
export function deriveKek(privateKey: KeyObject, publicKey: KeyObject): Buffer {
  const shared = diffieHellman({ privateKey, publicKey });
  return Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("onemoments/v1/wrap"), 32),
  );
}

function signaturePayload(input: {
  conversationId: string;
  clientMessageId: string;
  ciphertext: string;
}): Buffer {
  const digest = createHash("sha256")
    .update(Buffer.from(input.ciphertext, "base64"))
    .digest("base64");
  return Buffer.from(
    `${input.conversationId}\n${input.clientMessageId}\n${digest}`,
    "utf8",
  );
}

function aesGcmEncrypt(key: Buffer, nonce: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function aesGcmDecrypt(key: Buffer, nonce: Buffer, payload: Buffer): Buffer {
  const tag = payload.subarray(payload.length - 16);
  const body = payload.subarray(0, payload.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export interface RecipientDevice {
  deviceId: string;
  identityPublicKey: string;
}

export interface DeviceKeyPayload {
  deviceId: string;
  ephemeralPublicKey: string;
  wrappedKey: string;
  wrapNonce: string;
  version?: number;
}

export interface EncryptedPayload {
  clientMessageId: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  keys: DeviceKeyPayload[];
}

export interface MessageViewLike {
  conversationId: string;
  clientMessageId: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  key: {
    deviceId: string;
    ephemeralPublicKey: string;
    wrappedKey: string;
    wrapNonce: string;
  };
}

export function encryptMessage(input: {
  conversationId: string;
  clientMessageId: string;
  plaintext: string;
  sender: Identity;
  recipients: RecipientDevice[];
}): EncryptedPayload {
  const contentKey = randomBytes(32);
  const nonce = randomBytes(12);
  const ciphertext = aesGcmEncrypt(
    contentKey,
    nonce,
    Buffer.from(input.plaintext, "utf8"),
  ).toString("base64");

  const keys: DeviceKeyPayload[] = input.recipients.map((recipient) => {
    const ephemeral = generateKeyPairSync("x25519");
    const kek = deriveKek(
      ephemeral.privateKey,
      x25519PublicKeyFromBase64(recipient.identityPublicKey),
    );
    const wrapNonce = randomBytes(12);
    return {
      deviceId: recipient.deviceId,
      ephemeralPublicKey: rawPublicKeyBase64(ephemeral.publicKey),
      wrappedKey: aesGcmEncrypt(kek, wrapNonce, contentKey).toString("base64"),
      wrapNonce: wrapNonce.toString("base64"),
      version: 1,
    };
  });

  const signature = sign(
    null,
    signaturePayload({
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      ciphertext,
    }),
    input.sender.signing.privateKey,
  ).toString("base64");

  return {
    clientMessageId: input.clientMessageId,
    ciphertext,
    nonce: nonce.toString("base64"),
    signature,
    keys,
  };
}

export function decryptMessage(input: {
  identity: Identity;
  senderSigningPublicKey: string;
  message: MessageViewLike;
}): string {
  const ephemeralPublicKey = x25519PublicKeyFromBase64(input.message.key.ephemeralPublicKey);
  const kek = deriveKek(input.identity.identity.privateKey, ephemeralPublicKey);
  const contentKey = aesGcmDecrypt(
    kek,
    Buffer.from(input.message.key.wrapNonce, "base64"),
    Buffer.from(input.message.key.wrappedKey, "base64"),
  );
  const plaintext = aesGcmDecrypt(
    contentKey,
    Buffer.from(input.message.nonce, "base64"),
    Buffer.from(input.message.ciphertext, "base64"),
  ).toString("utf8");

  const valid = verify(
    null,
    signaturePayload({
      conversationId: input.message.conversationId,
      clientMessageId: input.message.clientMessageId,
      ciphertext: input.message.ciphertext,
    }),
    ed25519PublicKeyFromBase64(input.senderSigningPublicKey),
    Buffer.from(input.message.signature, "base64"),
  );
  if (!valid) throw new Error("Invalid message signature");
  return plaintext;
}
