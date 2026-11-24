import { describe, expect, it } from "vitest";

import { isViewOnceLocked, viewOnceHint } from "./viewOnce.ts";

describe("view once helpers", () => {
  it("locks view-once messages only for the recipient until opened", () => {
    expect(isViewOnceLocked({ viewOnce: true, own: false, opened: false })).toBe(true);
    expect(isViewOnceLocked({ viewOnce: true, own: false, opened: true })).toBe(false);
    expect(isViewOnceLocked({ viewOnce: true, own: true, opened: false })).toBe(false);
    expect(isViewOnceLocked({ viewOnce: false, own: false, opened: false })).toBe(false);
  });

  it("explains who deletes the message", () => {
    expect(viewOnceHint(true)).toBe("상대가 열면 사라집니다");
    expect(viewOnceHint(false)).toBe("한 번 열면 사라집니다");
  });
});
