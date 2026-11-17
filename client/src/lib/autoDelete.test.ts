import { describe, expect, it } from "vitest";

import { AUTO_DELETE_OPTIONS, autoDeleteAt, autoDeleteLabel } from "./autoDelete.ts";

describe("auto delete options", () => {
  it("offers off, 1 day, 7 days and 30 days", () => {
    expect(AUTO_DELETE_OPTIONS.map((option) => option.label)).toEqual([
      "끔",
      "1일",
      "7일",
      "30일",
    ]);
    expect(AUTO_DELETE_OPTIONS.map((option) => option.seconds)).toEqual([
      null,
      86_400,
      604_800,
      2_592_000,
    ]);
  });

  it("formats a configured retention", () => {
    expect(autoDeleteLabel(null)).toBe("끔");
    expect(autoDeleteLabel(86_400)).toBe("1일");
    expect(autoDeleteLabel(604_800)).toBe("7일");
    expect(autoDeleteLabel(2_592_000)).toBe("30일");
    expect(autoDeleteLabel(3_600)).toBe("1시간");
    expect(autoDeleteLabel(90)).toBe("90초");
  });

  it("computes the deletion time from the last read time", () => {
    const readAt = new Date("2026-01-01T00:00:00.000Z");
    expect(autoDeleteAt(readAt, 86_400).toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });
});
