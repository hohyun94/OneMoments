import { subtle, type DeviceIdentity, type IdentityBackend } from "./keys.ts";
import { fromBase64, randomBytes, toBase64 } from "./encoding.ts";
import type { HistoryKeyRecord, LocalCryptoState, RatchetSession } from "./ratchet.ts";

const VERSION = 1 as const;
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type BackupFailure = "passphrase" | "format";

export class BackupError extends Error {
  constructor(readonly reason: BackupFailure) {
    super(`Key backup error: ${reason}`);
    this.name = "BackupError";
  }
}

export interface KeyBackupBlob {
  version: 1;
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
  };
  nonce: string;
  ciphertext: string;
}

interface BackupPayload {
  version: 1;
  backend: IdentityBackend;
  deviceId: string;
  identityPublicKey: string;
  signingPublicKey: string;
  identityPrivate: string;
  signingPrivate: string;
  /** Double Ratchet 세션 + 이력 키. 복구 후 기존 DR 이력을 읽기 위해 필요하다. */
  state?: LocalCryptoState;
  createdAt: string;
}

export interface ImportedKeyBackup extends DeviceIdentity {
  state: LocalCryptoState | null;
}

async function deriveBackupKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await subtle().importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function exportPrivateKey(key: CryptoKey | string): Promise<string> {
  if (typeof key === "string") return key;
  if (!key.extractable) throw new BackupError("format");
  const pkcs8 = await subtle().exportKey("pkcs8", key);
  return toBase64(new Uint8Array(pkcs8));
}

async function importPrivateKey(
  backend: IdentityBackend,
  value: string,
  kind: "identity" | "signing",
): Promise<CryptoKey | string> {
  if (backend === "noble") return value;
  return subtle().importKey(
    "pkcs8",
    fromBase64(value),
    { name: kind === "identity" ? "X25519" : "Ed25519" },
    true,
    kind === "identity" ? ["deriveBits"] : ["sign"],
  );
}

/** 기기 신원 키를 복구 암호로 암호화한 블롭을 만든다(서버는 복호화하지 않는다). */
export async function exportKeyBackup(
  identity: DeviceIdentity,
  passphrase: string,
  state?: LocalCryptoState,
): Promise<KeyBackupBlob> {
  if (!identity.deviceId) throw new BackupError("format");
  if (passphrase.length < 10) throw new BackupError("format");

  const payload: BackupPayload = {
    version: VERSION,
    backend: identity.backend,
    deviceId: identity.deviceId,
    identityPublicKey: identity.identityPublicKey,
    signingPublicKey: identity.signingPublicKey,
    identityPrivate: await exportPrivateKey(identity.identityPrivate),
    signingPrivate: await exportPrivateKey(identity.signingPrivate),
    ...(state ? { state } : {}),
    createdAt: new Date().toISOString(),
  };

  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await deriveBackupKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    encoder.encode(JSON.stringify(payload)),
  );

  return {
    version: VERSION,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: toBase64(salt),
    },
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

export async function importKeyBackup(
  blob: KeyBackupBlob,
  passphrase: string,
): Promise<ImportedKeyBackup> {
  if (
    blob.version !== VERSION ||
    blob.kdf?.name !== "PBKDF2" ||
    blob.kdf.hash !== "SHA-256" ||
    !Number.isInteger(blob.kdf.iterations) ||
    blob.kdf.iterations < 100_000 ||
    blob.kdf.iterations > 2_000_000
  ) {
    throw new BackupError("format");
  }

  let plaintext: Uint8Array;
  try {
    const key = await deriveBackupKey(
      passphrase,
      fromBase64(blob.kdf.salt),
      blob.kdf.iterations,
    );
    plaintext = new Uint8Array(
      await subtle().decrypt(
        { name: "AES-GCM", iv: fromBase64(blob.nonce) },
        key,
        fromBase64(blob.ciphertext),
      ),
    );
  } catch {
    throw new BackupError("passphrase");
  }

  let payload: BackupPayload;
  try {
    payload = JSON.parse(decoder.decode(plaintext)) as BackupPayload;
  } catch {
    throw new BackupError("format");
  }

  if (
    payload.version !== VERSION ||
    (payload.backend !== "webcrypto" && payload.backend !== "noble") ||
    typeof payload.deviceId !== "string" ||
    typeof payload.identityPublicKey !== "string" ||
    typeof payload.signingPublicKey !== "string" ||
    typeof payload.identityPrivate !== "string" ||
    typeof payload.signingPrivate !== "string"
  ) {
    throw new BackupError("format");
  }

  const state: LocalCryptoState | null =
    payload.state &&
    Array.isArray(payload.state.sessions) &&
    Array.isArray(payload.state.historyKeys)
      ? {
          sessions: payload.state.sessions.filter(
            (session): session is RatchetSession =>
              typeof session === "object" &&
              session !== null &&
              typeof session.conversationId === "string" &&
              typeof session.remoteDeviceId === "string" &&
              typeof session.dhSelfPrivate === "string",
          ),
          historyKeys: payload.state.historyKeys.filter(
            (record): record is HistoryKeyRecord =>
              typeof record === "object" &&
              record !== null &&
              typeof record.deviceId === "string" &&
              typeof record.messageId === "string" &&
              typeof record.key === "string" &&
              typeof record.savedAt === "number",
          ),
        }
      : null;

  return {
    state,
    backend: payload.backend,
    identityPrivate: await importPrivateKey(
      payload.backend,
      payload.identityPrivate,
      "identity",
    ),
    signingPrivate: await importPrivateKey(
      payload.backend,
      payload.signingPrivate,
      "signing",
    ),
    identityPublicKey: payload.identityPublicKey,
    signingPublicKey: payload.signingPublicKey,
    deviceId: payload.deviceId,
  };
}
