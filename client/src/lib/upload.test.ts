import { describe, expect, it } from "vitest";

import { uploadPercent } from "./upload.ts";

describe("upload progress", () => {
  it("computes a clamped percentage", () => {
    expect(uploadPercent(0, 100)).toBe(0);
    expect(uploadPercent(50, 100)).toBe(50);
    expect(uploadPercent(99.6, 100)).toBe(100);
    expect(uploadPercent(200, 100)).toBe(100);
  });

  it("returns 0 when the total size is unknown or invalid", () => {
    expect(uploadPercent(10, 0)).toBe(0);
    expect(uploadPercent(10, -5)).toBe(0);
    expect(uploadPercent(10, Number.NaN)).toBe(0);
    expect(uploadPercent(10, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
