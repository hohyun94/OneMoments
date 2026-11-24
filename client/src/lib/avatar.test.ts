import { describe, expect, it } from "vitest";

import {
  avatarInitial,
  avatarUrl,
  AVATAR_MAX_INPUT_BYTES,
  validateAvatarFile,
} from "./avatar.ts";

describe("avatar helpers", () => {
  it("accepts only raster image types under the size limit", () => {
    expect(validateAvatarFile({ type: "image/png", size: 1024 })).toBeNull();
    expect(validateAvatarFile({ type: "image/jpeg", size: 1024 })).toBeNull();
    expect(validateAvatarFile({ type: "image/webp", size: 1024 })).toBeNull();
    expect(validateAvatarFile({ type: "image/gif", size: 1024 })).toBe(
      "PNG·JPEG·WebP 이미지만 올릴 수 있습니다.",
    );
    expect(validateAvatarFile({ type: "image/png", size: 0 })).toBe("빈 파일은 올릴 수 없습니다.");
    expect(
      validateAvatarFile({ type: "image/png", size: AVATAR_MAX_INPUT_BYTES + 1 }),
    ).toBe("이미지는 8MB 이하만 올릴 수 있습니다.");
  });

  it("builds a cache-busting avatar URL only when an avatar exists", () => {
    expect(avatarUrl("u1", null)).toBeNull();
    expect(avatarUrl("u1", "2026-01-02T03:04:05.000Z")).toBe(
      "/api/users/u1/avatar?v=2026-01-02T03%3A04%3A05.000Z",
    );
  });

  it("derives an initial for users without an avatar", () => {
    expect(avatarInitial("@Alice")).toBe("A");
    expect(avatarInitial("bob")).toBe("B");
    expect(avatarInitial("  ")).toBe("?");
    expect(avatarInitial(null)).toBe("?");
  });
});
