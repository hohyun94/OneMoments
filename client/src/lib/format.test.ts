import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "./format.ts";

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-03-01T12:00:00.000Z");

  it("formats recent times in Korean", () => {
    expect(formatRelativeTime("2026-03-01T11:59:30.000Z", now)).toBe("방금 전");
    expect(formatRelativeTime("2026-03-01T11:55:00.000Z", now)).toBe("5분 전");
    expect(formatRelativeTime("2026-03-01T09:00:00.000Z", now)).toBe("3시간 전");
    expect(formatRelativeTime("2026-02-27T12:00:00.000Z", now)).toBe("2일 전");
  });

  it("treats future timestamps as just now and rejects invalid input", () => {
    expect(formatRelativeTime("2026-03-01T12:05:00.000Z", now)).toBe("방금 전");
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });
});
