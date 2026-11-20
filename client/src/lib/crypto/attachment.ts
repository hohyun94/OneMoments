import { decoder, encoder, fromBase64, randomBytes, toBase64, toBytes } from "./encoding.ts";

/** 클라이언트 파일 크기 한도(서버 ATTACHMENT_MAX_BYTES 기본 8MB보다 작게 유지). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_MESSAGE_PREFIX = "onemoments:attachment:v1:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AttachmentFailure = "empty" | "too-large" | "invalid";

export class AttachmentError extends Error {
  constructor(
    readonly reason: AttachmentFailure,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

export interface EncryptedAttachment {
  ciphertext: Uint8Array<ArrayBuffer>;
  /** AES-256 raw key(base64). 메시지 암호문 안에만 들어간다. */
  key: string;
  /** 12바이트 GCM nonce(base64) */
  iv: string;
}

export async function encryptAttachment(file: File): Promise<EncryptedAttachment> {
  if (file.size === 0) {
    throw new AttachmentError("empty", "빈 파일은 첨부할 수 없습니다.");
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError("too-large", "파일은 5MB 이하만 첨부할 수 있습니다.");
  }

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const iv = randomBytes(12);
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return { ciphertext, key: toBase64(rawKey), iv: toBase64(iv) };
}

export async function decryptAttachment(
  ciphertext: ArrayBuffer | Uint8Array,
  key: string,
  iv: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    fromBase64(key),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const data = ciphertext instanceof Uint8Array ? toBytes(ciphertext) : new Uint8Array(ciphertext);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, cryptoKey, data),
  );
}

/** 파일 이름·MIME·키는 메시지 본문(이미 E2E 암호화됨) 안에만 존재한다. */
export interface AttachmentPayload {
  id: string;
  name: string;
  mime: string;
  size: number;
  key: string;
  iv: string;
  text: string;
  /** 음성 메시지 길이(초). 일반 파일에는 없다. */
  durationSeconds?: number;
  /** 음성 파형(0~100 막대). 송신자가 한 번 계산해 암호문에 담는다. */
  waveform?: number[];
}

export function encodeAttachmentPayload(payload: AttachmentPayload): string {
  return `${ATTACHMENT_MESSAGE_PREFIX}${toBase64(
    encoder.encode(JSON.stringify(payload)),
  )}`;
}

export function parseAttachmentPayload(content: string): AttachmentPayload | null {
  if (!content.startsWith(ATTACHMENT_MESSAGE_PREFIX)) return null;
  try {
    const raw = decoder.decode(fromBase64(content.slice(ATTACHMENT_MESSAGE_PREFIX.length)));
    const value = JSON.parse(raw) as Partial<AttachmentPayload>;
    if (typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) return null;
    if (typeof value.name !== "string" || value.name.length === 0 || value.name.length > 255) {
      return null;
    }
    if (typeof value.mime !== "string" || value.mime.length > 128) return null;
    if (typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0) {
      return null;
    }
    if (typeof value.key !== "string" || value.key.length === 0) return null;
    if (typeof value.iv !== "string" || value.iv.length === 0) return null;
    if (typeof value.text !== "string" || value.text.length > 4096) return null;
    if (value.durationSeconds !== undefined) {
      if (
        typeof value.durationSeconds !== "number" ||
        !Number.isFinite(value.durationSeconds) ||
        value.durationSeconds < 0 ||
        value.durationSeconds > 7_200
      ) {
        return null;
      }
    }
    if (value.waveform !== undefined) {
      if (
        !Array.isArray(value.waveform) ||
        value.waveform.length === 0 ||
        value.waveform.length > 64 ||
        !value.waveform.every(
          (peak) =>
            typeof peak === "number" && Number.isFinite(peak) && peak >= 0 && peak <= 100,
        )
      ) {
        return null;
      }
    }
    return {
      id: value.id,
      name: value.name,
      mime: value.mime,
      size: value.size,
      key: value.key,
      iv: value.iv,
      text: value.text,
      ...(typeof value.durationSeconds === "number"
        ? { durationSeconds: value.durationSeconds }
        : {}),
      ...(Array.isArray(value.waveform) ? { waveform: value.waveform } : {}),
    };
  } catch {
    return null;
  }
}
