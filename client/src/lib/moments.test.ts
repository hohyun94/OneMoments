import { describe, expect, it } from "vitest";

import { encodeAttachmentPayload } from "./crypto/index.ts";
import { momentTimeLeft, parseMomentContent } from "./moments.ts";

describe("moments helpers", () => {
  it("formats the remaining 24h window", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(momentTimeLeft("2026-01-01T05:10:00.000Z", now)).toBe("5시간 남음");
    expect(momentTimeLeft("2026-01-01T00:20:00.000Z", now)).toBe("20분 남음");
    expect(momentTimeLeft("2025-12-31T23:59:00.000Z", now)).toBe("만료됨");
  });

  it("separates plain text from encrypted attachment metadata", () => {
    expect(parseMomentContent("hello")).toEqual({ text: "hello", attachment: null });

    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const encoded = encodeAttachmentPayload({
      id: attachmentId,
      name: "photo.jpg",
      mime: "image/jpeg",
      size: 1234,
      key: "a2V5",
      iv: "aXY=",
      text: "caption",
    });
    const parsed = parseMomentContent(encoded);
    expect(parsed.text).toBe("caption");
    expect(parsed.attachment?.id).toBe(attachmentId);
    expect(parsed.attachment?.name).toBe("photo.jpg");
  });
});
