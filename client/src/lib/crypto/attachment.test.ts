import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_MESSAGE_PREFIX,
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  decryptAttachment,
  encodeAttachmentPayload,
  encryptAttachment,
  parseAttachmentPayload,
} from "./index.ts";
import { decoder, encoder, fromBase64, toBase64 } from "./encoding.ts";

function textFile(content: string, name = "메모.txt", type = "text/plain"): File {
  return new File([encoder.encode(content)], name, { type });
}

describe("encrypted attachments", () => {
  it("round-trips file bytes with a per-file AES-GCM key", async () => {
    const original = "첨부 파일의 비밀 내용 🔐";
    const encrypted = await encryptAttachment(textFile(original));

    expect(encrypted.key).not.toBe("");
    expect(encrypted.iv).not.toBe("");
    expect(decoder.decode(encrypted.ciphertext)).not.toContain(original);

    const decrypted = await decryptAttachment(
      encrypted.ciphertext,
      encrypted.key,
      encrypted.iv,
    );
    expect(decoder.decode(decrypted)).toBe(original);
  });

  it("rejects decryption with a different key", async () => {
    const encrypted = await encryptAttachment(textFile("tamper"));
    const wrongKey = toBase64(fromBase64(encrypted.key).map((byte) => byte ^ 0xff));
    await expect(
      decryptAttachment(encrypted.ciphertext, wrongKey, encrypted.iv),
    ).rejects.toThrow();
  });

  it("encodes attachment metadata inside the message text", () => {
    const payload = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "회의 기록.txt",
      mime: "text/plain",
      size: 1234,
      key: "a2V5",
      iv: "aXY=",
      text: "오늘 회의록",
    };
    const encoded = encodeAttachmentPayload(payload);
    expect(encoded.startsWith(ATTACHMENT_MESSAGE_PREFIX)).toBe(true);
    expect(encoded).not.toContain(payload.name);
    expect(parseAttachmentPayload(encoded)).toEqual(payload);

    expect(parseAttachmentPayload("일반 텍스트")).toBeNull();
    expect(parseAttachmentPayload(`${ATTACHMENT_MESSAGE_PREFIX}%%%`)).toBeNull();
    const invalid = encodeAttachmentPayload({ ...payload, id: "not-a-uuid" });
    expect(parseAttachmentPayload(invalid)).toBeNull();
  });

  it("rejects empty and oversized files", async () => {
    await expect(encryptAttachment(textFile(""))).rejects.toBeInstanceOf(AttachmentError);
    const oversized = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "big.bin");
    await expect(encryptAttachment(oversized)).rejects.toMatchObject({
      reason: "too-large",
    });
  });
});
