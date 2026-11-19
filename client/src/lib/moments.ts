import {
  decryptMessage,
  encryptMessage,
  parseAttachmentPayload,
  type AttachmentPayload,
  type StoredIdentity,
} from "./crypto/index.ts";
import type { MomentDevice, MomentView } from "../types.ts";

export interface MomentPayload {
  id: string;
  audienceUserIds: string[];
  attachmentId?: string;
}

/** 스토리 본문/이미지 메타데이터를 기존 봉투 경로로 암호화한다. */
export async function encryptMoment(input: {
  identity: StoredIdentity;
  plaintext: string;
  devices: MomentDevice[];
  audienceUserIds: string[];
  attachmentId?: string;
  id?: string;
}): Promise<{
  id: string;
  audienceUserIds: string[];
  attachmentId?: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  keys: Awaited<ReturnType<typeof encryptMessage>>["keys"];
}> {
  if (input.devices.length === 0) throw new Error("공개할 기기가 없습니다.");
  const id = input.id ?? crypto.randomUUID();
  const payload = await encryptMessage({
    identity: input.identity,
    conversationId: id,
    clientMessageId: id,
    plaintext: input.plaintext,
    recipients: input.devices.map((device) => ({
      deviceId: device.id,
      identityPublicKey: device.identityPublicKey,
      signedPreKeyId: device.signedPreKeyId,
      signedPreKeyPublicKey: device.signedPreKeyPublicKey,
      signedPreKeySignature: device.signedPreKeySignature,
      oneTimePreKeyId: device.oneTimePreKeyId,
      oneTimePreKeyPublicKey: device.oneTimePreKeyPublicKey,
    })),
  });
  return {
    id,
    audienceUserIds: input.audienceUserIds,
    ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
    ciphertext: payload.ciphertext,
    nonce: payload.nonce,
    signature: payload.signature,
    keys: payload.keys,
  };
}

export async function decryptMoment(
  identity: StoredIdentity,
  moment: MomentView,
): Promise<string> {
  if (!moment.key) throw new Error("이 기기에서 이 순간을 읽을 수 없습니다.");
  return decryptMessage({
    identity,
    message: {
      conversationId: moment.id,
      clientMessageId: moment.id,
      ciphertext: moment.ciphertext,
      nonce: moment.nonce,
      signature: moment.signature,
      senderSigningPublicKey: moment.authorSigningPublicKey,
      key: moment.key,
    },
  });
}

export function parseMomentContent(
  plaintext: string,
): { text: string; attachment: AttachmentPayload | null } {
  const attachment = parseAttachmentPayload(plaintext);
  return attachment
    ? { text: attachment.text, attachment }
    : { text: plaintext, attachment: null };
}

export function momentTimeLeft(expiresAt: string, now = Date.now()): string {
  const remaining = Date.parse(expiresAt) - now;
  if (remaining <= 0) return "만료됨";
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}시간 남음`;
  const minutes = Math.max(1, Math.floor(remaining / (60 * 1000)));
  return `${minutes}분 남음`;
}

export function isMomentAuthor(moment: MomentView, userId: string): boolean {
  return moment.author.id === userId;
}
