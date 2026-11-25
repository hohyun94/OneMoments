import { describe, expect, it } from "vitest";

import { formatClock, formatDayLabel, formatListTime, formatRelativeTime } from "./format.ts";

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-03-01T12:00:00.000Z");

  it("formats recent times in Korean", () => {
    expect(formatRelativeTime("2026-03-01T11:59:30.000Z", now)).toBe("방금 전");
    expect(formatRelativeTime("2026-03-01T11:55:00.000Z", now)).toBe("5분 전");
    expect(formatRelativeTime("2026-03-01T09:00:00.000Z", now)).toBe("3시간 전");
    expect(formatRelativeTime("2026-02-27T12:00:00.000Z", now)).toBe("2일 전");
  });

  it("formats the same offsets in English", () => {
    expect(formatRelativeTime("2026-03-01T11:59:30.000Z", now, "en")).toBe("just now");
    expect(formatRelativeTime("2026-03-01T11:55:00.000Z", now, "en")).toBe("5 min ago");
    expect(formatRelativeTime("2026-03-01T09:00:00.000Z", now, "en")).toBe("3 hr ago");
    expect(formatRelativeTime("2026-02-27T12:00:00.000Z", now, "en")).toBe("2 d ago");
  });

  it("treats future timestamps as just now and rejects invalid input", () => {
    expect(formatRelativeTime("2026-03-01T12:05:00.000Z", now)).toBe("방금 전");
    expect(formatRelativeTime("2026-03-01T12:05:00.000Z", now, "en")).toBe("just now");
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });
});

describe("locale-aware date formats", () => {
  const sample = "2026-03-01T09:30:00.000Z";

  it("uses the locale's clock format and defaults to Korean", () => {
    const options = { hour: "2-digit", minute: "2-digit" } as const;
    expect(formatClock(sample, "ko")).toBe(
      new Date(sample).toLocaleTimeString("ko-KR", options),
    );
    expect(formatClock(sample, "en")).toBe(
      new Date(sample).toLocaleTimeString("en-US", options),
    );
    expect(formatClock(sample)).toBe(new Date(sample).toLocaleTimeString("ko-KR", options));
  });

  it("labels today and yesterday through the dictionary", () => {
    const now = new Date();
    expect(formatDayLabel(now.toISOString(), "ko")).toBe("오늘");
    expect(formatDayLabel(now.toISOString(), "en")).toBe("Today");

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    expect(formatDayLabel(yesterday.toISOString(), "ko")).toBe("어제");
    expect(formatDayLabel(yesterday.toISOString(), "en")).toBe("Yesterday");
  });

  it("formats older days with the locale's date order", () => {
    const old = "2024-02-03T09:30:00.000Z";
    const options = { year: "numeric", month: "long", day: "numeric" } as const;
    expect(formatDayLabel(old, "ko")).toBe(
      new Date(old).toLocaleDateString("ko-KR", options),
    );
    expect(formatDayLabel(old, "en")).toBe(
      new Date(old).toLocaleDateString("en-US", options),
    );
  });

  it("returns an empty list time for a missing timestamp", () => {
    expect(formatListTime(null)).toBe("");
  });
});
