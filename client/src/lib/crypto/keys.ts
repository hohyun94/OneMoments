import { ed25519, x25519 } from "@noble/curves/ed25519";

import { encoder, fromBase64, randomBytes, toBase64, toBytes } from "./encoding.ts";

export type IdentityBackend = "webcrypto" | "noble";

export interface DeviceIdentity {
  backend: IdentityBackend;
  identityPrivate: CryptoKey | string;
  signingPrivate: CryptoKey | string;
  identityPublicKey: string;
  signingPublicKey: string;
  deviceId?: string;
  userId?: string;
}

export interface StoredIdentity extends DeviceIdentity {
  username: string;
}

export const subtle = (): SubtleCrypto => {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("WebCrypto is not available");
  return value;
};

let backendPromise: Promise<IdentityBackend> | null = null;

/** X25519/Ed25519 WebCrypto 지원 여부를 한 번만 확인한다. */
export function detectBackend(): Promise<IdentityBackend> {
  backendPromise ??= (async () => {
    try {
      await subtle().generateKey({ name: "X25519" }, false, ["deriveBits"]);
      await subtle().generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
      return "webcrypto";
    } catch {
      return "noble";
    }
  })();
  return backendPromise;
}

async function createWebCryptoIdentity(): Promise<DeviceIdentity> {
  const ecdh = (await subtle().generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const identityPublicKey = toBase64(
    new Uint8Array(await subtle().exportKey("raw", ecdh.publicKey)),
  );
  const ecdhPrivatePkcs8 = await subtle().exportKey("pkcs8", ecdh.privateKey);
  const identityPrivate = await subtle().importKey(
    "pkcs8",
    ecdhPrivatePkcs8,
    { name: "X25519" },
    false,
    ["deriveBits"],
  );

  const signing = (await subtle().generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const signingPublicKey = toBase64(
    new Uint8Array(await subtle().exportKey("raw", signing.publicKey)),
  );
  const signingPrivatePkcs8 = await subtle().exportKey("pkcs8", signing.privateKey);
  const signingPrivate = await subtle().importKey(
    "pkcs8",
    signingPrivatePkcs8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );

  return {
    backend: "webcrypto",
    identityPrivate,
    signingPrivate,
    identityPublicKey,
    signingPublicKey,
  };
}

function createNobleIdentity(): DeviceIdentity {
  const identityPrivate = x25519.utils.randomPrivateKey();
  const signingPrivate = ed25519.utils.randomPrivateKey();
  return {
    backend: "noble",
    identityPrivate: toBase64(identityPrivate),
    signingPrivate: toBase64(signingPrivate),
    identityPublicKey: toBase64(x25519.getPublicKey(identityPrivate)),
    signingPublicKey: toBase64(ed25519.getPublicKey(signingPrivate)),
  };
}

export async function createIdentity(): Promise<DeviceIdentity> {
  if ((await detectBackend()) === "webcrypto") return createWebCryptoIdentity();
  return createNobleIdentity();
}

/** 테스트·진단용: 백엔드를 명시해 키를 만든다. */
export async function createIdentityWithBackend(
  backend: IdentityBackend,
): Promise<DeviceIdentity> {
  if (backend === "webcrypto") return createWebCryptoIdentity();
  return createNobleIdentity();
}

export async function generateEphemeral(
  backend: IdentityBackend,
): Promise<{ privateKey: CryptoKey | string; publicKey: string }> {
  if (backend === "webcrypto") {
    const pair = (await subtle().generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
    return { privateKey: pair.privateKey, publicKey: toBase64(raw) };
  }
  const privateKey = x25519.utils.randomPrivateKey();
  return {
    privateKey: toBase64(privateKey),
    publicKey: toBase64(x25519.getPublicKey(privateKey)),
  };
}

async function importX25519Public(publicKeyBase64: string): Promise<CryptoKey> {
  return subtle().importKey(
    "raw",
    fromBase64(publicKeyBase64),
    { name: "X25519" },
    true,
    [],
  );
}

export async function deriveShared(
  backend: IdentityBackend,
  privateKey: CryptoKey | string,
  publicKeyBase64: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (backend === "webcrypto") {
    const publicKey = await importX25519Public(publicKeyBase64);
    const bits = await subtle().deriveBits(
      { name: "X25519", public: publicKey },
      privateKey as CryptoKey,
      256,
    );
    return new Uint8Array(bits);
  }
  return toBytes(
    x25519.getSharedSecret(
      fromBase64(privateKey as string),
      fromBase64(publicKeyBase64),
    ),
  );
}

export async function deriveKek(
  shared: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const hkdf = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode("onemoments/v1/wrap"),
    },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function importContentKey(
  raw: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  return subtle().importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function aesEncrypt(
  key: CryptoKey,
  nonce: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const result = await subtle().encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext);
  return new Uint8Array(result);
}

export async function aesDecrypt(
  key: CryptoKey,
  nonce: Uint8Array<ArrayBuffer>,
  payload: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const result = await subtle().decrypt({ name: "AES-GCM", iv: nonce }, key, payload);
  return new Uint8Array(result);
}

export { randomBytes };

export async function signaturePayload(
  conversationId: string,
  clientMessageId: string,
  ciphertextBase64: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await subtle().digest("SHA-256", fromBase64(ciphertextBase64));
  const digestBase64 = toBase64(new Uint8Array(digest));
  return encoder.encode(`${conversationId}\n${clientMessageId}\n${digestBase64}`);
}

export async function signPayload(
  backend: IdentityBackend,
  signingPrivate: CryptoKey | string,
  payload: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (backend === "webcrypto") {
    const signature = await subtle().sign(
      { name: "Ed25519" },
      signingPrivate as CryptoKey,
      payload,
    );
    return new Uint8Array(signature);
  }
  return toBytes(ed25519.sign(payload, fromBase64(signingPrivate as string)));
}

export async function verifyPayload(
  backend: IdentityBackend,
  signingPublicKeyBase64: string,
  payload: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  if (backend === "webcrypto") {
    const publicKey = await subtle().importKey(
      "raw",
      fromBase64(signingPublicKeyBase64),
      { name: "Ed25519" },
      true,
      ["verify"],
    );
    return subtle().verify({ name: "Ed25519" }, publicKey, signature, payload);
  }
  return ed25519.verify(
    toBytes(signature),
    toBytes(payload),
    fromBase64(signingPublicKeyBase64),
  );
}
