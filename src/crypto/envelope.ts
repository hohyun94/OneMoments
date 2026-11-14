import { AppError } from "../http/errors.js";

/**
 * 암호문 봉투 검증. 서버는 복호화하지 않고 형식·크기만 확인한다.
 *
 * - ciphertext: AES-256-GCM(ciphertext||tag) base64, 17바이트 이상
 * - nonce: 12바이트 base64
 * - signature: Ed25519 64바이트 base64
 * - keys[]: 기기별로 감싼 콘텐츠 키
 *   - ephemeralPublicKey: X25519 32바이트
 *   - wrapNonce: 12바이트
 *   - wrappedKey: AES-256-GCM(KEK, nonce, 32바이트 키) = 48바이트 이상
 */
export const ENVELOPE_VERSION = 1;
export const RATCHET_ENVELOPE_VERSION = 2;
export const MAX_RATCHET_INDEX = 1_000_000;
export const GCM_NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const X25519_KEY_BYTES = 32;
export const ED25519_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;
export const MIN_WRAPPED_KEY_BYTES = 48;
export const MAX_WRAPPED_KEY_BYTES = 256;

const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function decodeBase64(value: string, field: string): Buffer {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !BASE64_PATTERN.test(trimmed)) {
    throw AppError.badRequest("INVALID_ENVELOPE", `${field} must be base64`);
  }
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  if (normalized.length % 4 === 1) {
    throw AppError.badRequest("INVALID_ENVELOPE", `${field} has invalid base64 length`);
  }
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const bytes = Buffer.from(padded, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== padded) {
    throw AppError.badRequest("INVALID_ENVELOPE", `${field} must be base64`);
  }
  return bytes;
}

export function canonicalBase64(value: string, field: string): string {
  return decodeBase64(value, field).toString("base64");
}

export function requireBytes(value: string, field: string, expected: number): string {
  const bytes = decodeBase64(value, field);
  if (bytes.length !== expected) {
    throw AppError.badRequest("INVALID_ENVELOPE", `${field} must be ${expected} bytes`);
  }
  return bytes.toString("base64");
}

export function requireBytesInRange(
  value: string,
  field: string,
  min: number,
  max: number,
): string {
  const bytes = decodeBase64(value, field);
  if (bytes.length < min || bytes.length > max) {
    throw AppError.badRequest("INVALID_ENVELOPE", `${field} must be ${min}..${max} bytes`);
  }
  return bytes.toString("base64");
}

export function normalizeDeviceKeys(input: {
  identityPublicKey: string;
  signingPublicKey: string;
}): { identityPublicKey: string; signingPublicKey: string } {
  return {
    identityPublicKey: requireBytes(input.identityPublicKey, "identityPublicKey", X25519_KEY_BYTES),
    signingPublicKey: requireBytes(input.signingPublicKey, "signingPublicKey", ED25519_KEY_BYTES),
  };
}

export interface MessageKeyInput {
  deviceId: string;
  ephemeralPublicKey?: string | undefined;
  ratchetPublicKey?: string | undefined;
  previousChainLength?: number | undefined;
  messageNumber?: number | undefined;
  distributionCiphertext?: string | undefined;
  distributionNonce?: string | undefined;
  distribution?: { ciphertext: string; nonce: string } | undefined;
  wrappedKey: string;
  wrapNonce: string;
  version?: number | undefined;
}

export interface MessagePayloadInput {
  clientMessageId: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  keys: MessageKeyInput[];
  senderKeyId?: string | undefined;
  senderKeyIteration?: number | undefined;
}

export type NormalizedDeviceDistribution = {
  ciphertext: string;
  nonce: string;
};

export type NormalizedMessageKey =
  | {
      deviceId: string;
      version: typeof ENVELOPE_VERSION;
      ephemeralPublicKey: string;
      wrappedKey: string;
      wrapNonce: string;
      distribution?: NormalizedDeviceDistribution;
    }
  | {
      deviceId: string;
      version: typeof RATCHET_ENVELOPE_VERSION;
      ratchetPublicKey: string;
      previousChainLength: number;
      messageNumber: number;
      wrappedKey: string;
      wrapNonce: string;
      distribution?: NormalizedDeviceDistribution;
    };

export interface NormalizedMessagePayload {
  clientMessageId: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  keys: NormalizedMessageKey[];
  senderKeyId: string | null;
  senderKeyIteration: number | null;
}

function requireRatchetIndex(value: number | undefined, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_RATCHET_INDEX
  ) {
    throw AppError.badRequest("INVALID_ENVELOPE", `${field} must be a non-negative integer`);
  }
  return value;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DISTRIBUTION_BYTES = 8192;

function normalizeSenderKey(
  input: Pick<MessagePayloadInput, "senderKeyId" | "senderKeyIteration">,
): { senderKeyId: string | null; senderKeyIteration: number | null } {
  const hasId = input.senderKeyId !== undefined;
  const hasIteration = input.senderKeyIteration !== undefined;
  if (hasId !== hasIteration) {
    throw AppError.badRequest(
      "INVALID_ENVELOPE",
      "senderKeyId and senderKeyIteration must be provided together",
    );
  }
  if (!hasId) return { senderKeyId: null, senderKeyIteration: null };
  if (!UUID_PATTERN.test(input.senderKeyId ?? "")) {
    throw AppError.badRequest("INVALID_ENVELOPE", "senderKeyId must be a UUID");
  }
  return {
    senderKeyId: input.senderKeyId ?? null,
    senderKeyIteration: requireRatchetIndex(input.senderKeyIteration, "senderKeyIteration"),
  };
}

export function normalizeMessagePayload(
  input: MessagePayloadInput,
  options: { maxCiphertextBytes: number; maxEnvelopes: number },
): NormalizedMessagePayload {
  const { senderKeyId, senderKeyIteration } = normalizeSenderKey(input);
  if (input.keys.length === 0 && senderKeyId === null) {
    throw AppError.badRequest("INVALID_ENVELOPE", "At least one device key is required");
  }
  if (input.keys.length > options.maxEnvelopes) {
    throw AppError.badRequest(
      "TOO_MANY_ENVELOPES",
      `At most ${options.maxEnvelopes} device keys are allowed`,
    );
  }

  const ciphertextBytes = decodeBase64(input.ciphertext, "ciphertext").length;
  if (ciphertextBytes < GCM_TAG_BYTES + 1) {
    throw AppError.badRequest(
      "INVALID_ENVELOPE",
      "ciphertext must contain AES-GCM ciphertext and tag",
    );
  }
  if (ciphertextBytes > options.maxCiphertextBytes) {
    throw AppError.payloadTooLarge(
      `ciphertext exceeds ${options.maxCiphertextBytes} bytes`,
    );
  }

  const seen = new Set<string>();
  const keys: NormalizedMessageKey[] = [];
  for (const key of input.keys) {
    if (seen.has(key.deviceId)) {
      throw AppError.badRequest("DUPLICATE_DEVICE_KEY", "Duplicate device key");
    }
    seen.add(key.deviceId);

    const version = key.version ?? ENVELOPE_VERSION;
    const wrappedKey = requireBytesInRange(
      key.wrappedKey,
      "wrappedKey",
      MIN_WRAPPED_KEY_BYTES,
      MAX_WRAPPED_KEY_BYTES,
    );
    const wrapNonce = requireBytes(key.wrapNonce, "wrapNonce", GCM_NONCE_BYTES);
    const distributionSource =
      key.distribution ??
      (key.distributionCiphertext !== undefined || key.distributionNonce !== undefined
        ? {
            ciphertext: key.distributionCiphertext,
            nonce: key.distributionNonce,
          }
        : undefined);
    const hasDistribution = distributionSource !== undefined;
    if (
      hasDistribution &&
      (distributionSource.ciphertext === undefined || distributionSource.nonce === undefined)
    ) {
      throw AppError.badRequest(
        "INVALID_ENVELOPE",
        "distributionCiphertext and distributionNonce must be provided together",
      );
    }
    const distribution = hasDistribution
      ? {
          ciphertext: requireBytesInRange(
            distributionSource.ciphertext ?? "",
            "distributionCiphertext",
            GCM_TAG_BYTES + 1,
            MAX_DISTRIBUTION_BYTES,
          ),
          nonce: requireBytes(
            distributionSource.nonce ?? "",
            "distributionNonce",
            GCM_NONCE_BYTES,
          ),
        }
      : undefined;

    if (version === ENVELOPE_VERSION) {
      keys.push({
        deviceId: key.deviceId,
        version: ENVELOPE_VERSION,
        ephemeralPublicKey: requireBytes(
          key.ephemeralPublicKey ?? "",
          "ephemeralPublicKey",
          X25519_KEY_BYTES,
        ),
        wrappedKey,
        wrapNonce,
        ...(distribution ? { distribution } : {}),
      });
      continue;
    }

    if (version === RATCHET_ENVELOPE_VERSION) {
      keys.push({
        deviceId: key.deviceId,
        version: RATCHET_ENVELOPE_VERSION,
        ratchetPublicKey: requireBytes(
          key.ratchetPublicKey ?? "",
          "ratchetPublicKey",
          X25519_KEY_BYTES,
        ),
        previousChainLength: requireRatchetIndex(
          key.previousChainLength,
          "previousChainLength",
        ),
        messageNumber: requireRatchetIndex(key.messageNumber, "messageNumber"),
        wrappedKey,
        wrapNonce,
        ...(distribution ? { distribution } : {}),
      });
      continue;
    }

    throw AppError.badRequest(
      "UNSUPPORTED_ENVELOPE_VERSION",
      `Envelope version must be ${ENVELOPE_VERSION} or ${RATCHET_ENVELOPE_VERSION}`,
    );
  }

  return {
    clientMessageId: input.clientMessageId,
    ciphertext: canonicalBase64(input.ciphertext, "ciphertext"),
    nonce: requireBytes(input.nonce, "nonce", GCM_NONCE_BYTES),
    signature: requireBytes(input.signature, "signature", ED25519_SIGNATURE_BYTES),
    keys,
    senderKeyId,
    senderKeyIteration,
  };
}
