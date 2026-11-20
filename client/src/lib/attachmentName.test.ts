import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_NAME_MAX,
  attachmentExtension,
  isTemporaryFileName,
  sanitizeAttachmentName,
  suggestedAttachmentName,
} from "./attachmentName.ts";

describe("attachment name", () => {
  it("keeps names the browser provided", () => {
    expect(suggestedAttachmentName({ name: "회의 사진.png", type: "image/png" })).toBe(
      "회의 사진.png",
    );
    expect(suggestedAttachmentName({ name: "IMG_1234.JPG", type: "image/jpeg" })).toBe(
      "IMG_1234.JPG",
    );
  });

  it("detects temporary or generic names", () => {
    expect(isTemporaryFileName("tmp_f870a5a7-aca3-4996-8270-4a1fde29c829.png")).toBe(true);
    expect(isTemporaryFileName("image.png")).toBe(true);
    expect(isTemporaryFileName("blob")).toBe(true);
    expect(isTemporaryFileName("   ")).toBe(true);
    expect(isTemporaryFileName("회의 사진.png")).toBe(false);
  });

  it("replaces temporary names with a dated default", () => {
    const name = suggestedAttachmentName(
      {
        name: "tmp_f870a5a7-aca3-4996-8270-4a1fde29c829.png",
        type: "image/png",
        lastModified: new Date(2026, 10, 20, 8, 52).getTime(),
      },
      new Date(2026, 10, 20, 9, 0),
    );
    expect(name).toBe("첨부-20261120-0852.png");
  });

  it("falls back to the mime extension", () => {
    expect(
      suggestedAttachmentName({
        name: "blob",
        type: "image/png",
        lastModified: new Date(2026, 0, 2, 3, 4).getTime(),
      }),
    ).toBe("첨부-20260102-0304.png");
    expect(attachmentExtension("noext", "application/pdf")).toBe("pdf");
    expect(attachmentExtension("a.tar.gz", "application/octet-stream")).toBe("gz");
  });

  it("strips paths and caps the length", () => {
    expect(sanitizeAttachmentName("C:\\fakepath\\사진.png")).toBe("사진.png");
    expect(sanitizeAttachmentName("a".repeat(300)).length).toBe(ATTACHMENT_NAME_MAX);
  });
});
