import { describe, expect, it } from "vitest";

import {
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  MAX_IDLE_TIMEOUT_SECONDS,
  MIN_IDLE_TIMEOUT_SECONDS,
  clampIdleTimeoutSeconds,
  effectiveIdleTimeoutSeconds,
  idleTimeoutLabel,
} from "./idleTimeout.ts";

describe("idle timeout policy", () => {
  it("clamps values to the 1~30 minute range", () => {
    expect(clampIdleTimeoutSeconds(0)).toBe(MIN_IDLE_TIMEOUT_SECONDS);
    expect(clampIdleTimeoutSeconds(59)).toBe(MIN_IDLE_TIMEOUT_SECONDS);
    expect(clampIdleTimeoutSeconds(60)).toBe(60);
    expect(clampIdleTimeoutSeconds(10 * 60)).toBe(600);
    expect(clampIdleTimeoutSeconds(30 * 60)).toBe(MAX_IDLE_TIMEOUT_SECONDS);
    expect(clampIdleTimeoutSeconds(31 * 60)).toBe(MAX_IDLE_TIMEOUT_SECONDS);
    expect(clampIdleTimeoutSeconds(Number.NaN)).toBe(DEFAULT_IDLE_TIMEOUT_SECONDS);
    expect(clampIdleTimeoutSeconds(90.9)).toBe(90);
  });

  it("prefers the session override over the device default", () => {
    expect(effectiveIdleTimeoutSeconds(300, null)).toBe(300);
    expect(effectiveIdleTimeoutSeconds(300, 60)).toBe(60);
    expect(effectiveIdleTimeoutSeconds(1800, 600)).toBe(600);
  });

  it("labels seconds as minutes when divisible", () => {
    expect(idleTimeoutLabel(60)).toBe("1분");
    expect(idleTimeoutLabel(300)).toBe("5분");
    expect(idleTimeoutLabel(1800)).toBe("30분");
    expect(idleTimeoutLabel(90)).toBe("90초");
  });
});
