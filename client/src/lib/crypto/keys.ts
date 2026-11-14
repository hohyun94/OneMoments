import { ed25519, x25519 } from "@noble/curves/ed25519";

import { encoder, fromBase64, randomBytes, toBase64, toBytes } from "./encoding.ts";

export type IdentityBackend = "webcrypto" | "noble";

export interface DeviceIdentity {
  backend: IdentityBackend;
  identityPrivate: CryptoKey | string;
  signingPrivate: CryptoKey | string;
  identityPublicKey: string;
  signingPublicKey: string;
  signedPreKeyPrivate?: CryptoKey | string;
  signedPreKeyPublicKey?: string;
  signedPreKeyId?: string;
  signedPreKeySignature?: string;
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

  const signing = (await subtle().generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const signingPublicKey = toBase64(
    new Uint8Array(await subtle().exportKey("raw", signing.publicKey)),
  );

  // 키 백업(복구)을 위해 private 키는 extractable 로 보관한다.
  // XSS 위험은 CSP·서드파티 스크립트 금지로 완화한다(README 보안 참고).
  return {
    backend: "webcrypto",
    identityPrivate: ecdh.privateKey,
    signingPrivate: signing.privateKey,
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

export function signedPreKeyMessage(
  id: string,
  publicKey: string,
): Uint8Array<ArrayBuffer> {
  return encoder.encode(`onemoments-signed-prekey:${id}:${publicKey}`);
}

/** X3DH signed prekey를 만들고 기기 서명키로 서명한다. */
export async function ensureSignedPreKey(
  identity: DeviceIdentity,
): Promise<DeviceIdentity> {
  if (
    identity.signedPreKeyPrivate &&
    identity.signedPreKeyPublicKey &&
    identity.signedPreKeyId &&
    identity.signedPreKeySignature
  ) {
    return identity;
  }
  const id = crypto.randomUUID();
  let privateKey: CryptoKey | string;
  let publicKey: string;
  if (identity.backend === "webcrypto") {
    const pair = (await subtle().generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    privateKey = pair.privateKey;
    publicKey = toBase64(new Uint8Array(await subtle().exportKey("raw", pair.publicKey)));
  } else {
    const raw = x25519.utils.randomPrivateKey();
    privateKey = toBase64(raw);
    publicKey = toBase64(x25519.getPublicKey(raw));
  }
  const signature = await signPayload(
    identity.backend,
    identity.signingPrivate,
    signedPreKeyMessage(id, publicKey),
  );
  return {
    ...identity,
    signedPreKeyPrivate: privateKey,
    signedPreKeyPublicKey: publicKey,
    signedPreKeyId: id,
    signedPreKeySignature: toBase64(signature),
  };
}

export async function createIdentity(): Promise<DeviceIdentity> {
  if ((await detectBackend()) === "webcrypto") {
    return ensureSignedPreKey(await createWebCryptoIdentity());
  }
  return ensureSignedPreKey(createNobleIdentity());
}

/** 테스트·진단용: 백엔드를 명시해 키를 만든다. */
export async function createIdentityWithBackend(
  backend: IdentityBackend,
): Promise<DeviceIdentity> {
  if (backend === "webcrypto") {
    return ensureSignedPreKey(await createWebCryptoIdentity());
  }
  return ensureSignedPreKey(createNobleIdentity());
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

export async function serializeX25519Private(
  backend: IdentityBackend,
  privateKey: CryptoKey | string,
): Promise<string> {
  if (backend === "noble") return privateKey as string;
  if (!(privateKey instanceof CryptoKey) || !privateKey.extractable) {
    throw new Error("X25519 private key is not exportable");
  }
  return toBase64(new Uint8Array(await subtle().exportKey("pkcs8", privateKey)));
}

/** 저장된 private key(pkcs8/noble raw)로 X25519 shared secret 을 계산한다. */
export async function deriveSharedSerialized(
  backend: IdentityBackend,
  privateKeySerialized: string,
  publicKeyBase64: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (backend === "noble") {
    return deriveShared(backend, privateKeySerialized, publicKeyBase64);
  }
  const privateKey = await subtle().importKey(
    "pkcs8",
    fromBase64(privateKeySerialized),
    { name: "X25519" },
    false,
    ["deriveBits"],
  );
  return deriveShared(backend, privateKey, publicKeyBase64);
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
