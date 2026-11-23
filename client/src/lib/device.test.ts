import { describe, expect, it } from "vitest";

import {
  detectPlatform,
  isMobilePlatform,
  platformLabel,
} from "./device.ts";

describe("device platform detection", () => {
  it("detects iPhone and Android user agents", () => {
    expect(
      detectPlatform({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        platform: "iPhone",
        maxTouchPoints: 5,
      }),
    ).toBe("ios");
    expect(
      detectPlatform({
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      }),
    ).toBe("android");
  });

  it("treats desktop-mode iPadOS as iOS", () => {
    expect(
      detectPlatform({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 5,
      }),
    ).toBe("ios");
  });

  it("uses Chromium mobile hints for generic mobile devices", () => {
    expect(
      detectPlatform({
        userAgent: "Mozilla/5.0 (Linux; Android 10; K) Chrome/120.0 Mobile",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
        userAgentDataMobile: true,
      }),
    ).toBe("android");
    expect(
      detectPlatform({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0",
        platform: "Linux x86_64",
        maxTouchPoints: 0,
        userAgentDataMobile: true,
      }),
    ).toBe("mobile");
  });

  it("detects desktops and falls back to unknown", () => {
    expect(
      detectPlatform({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
        platform: "Win32",
        maxTouchPoints: 0,
      }),
    ).toBe("desktop");
    expect(
      detectPlatform({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 0,
      }),
    ).toBe("desktop");
    expect(detectPlatform({ userAgent: "custom-client" })).toBe("unknown");
  });

  it("maps mobile platforms and labels", () => {
    expect(isMobilePlatform("ios")).toBe(true);
    expect(isMobilePlatform("android")).toBe(true);
    expect(isMobilePlatform("mobile")).toBe(true);
    expect(isMobilePlatform("desktop")).toBe(false);
    expect(platformLabel("ios")).toBe("iOS");
    expect(platformLabel("unknown")).toBe("알 수 없음");
  });
});
