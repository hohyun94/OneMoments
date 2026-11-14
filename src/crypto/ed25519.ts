import { createPublicKey, verify } from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** 기기 서명 공개키(32바이트 raw base64)로 Ed25519 서명을 검증한다. */
export function verifyEd25519Signature(
  publicKeyBase64: string,
  message: Buffer,
  signatureBase64: string,
): boolean {
  const rawKey = Buffer.from(publicKeyBase64, "base64");
  if (rawKey.length !== 32) return false;
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: "der",
      type: "spki",
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
