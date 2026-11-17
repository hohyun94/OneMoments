import { describe, expect, it } from "vitest";

import {
  ACCENT_PRESETS,
  DEFAULT_THEME,
  accentContrastColor,
  normalizeAccent,
  normalizeHex,
  normalizeTheme,
  resolveAccentColor,
} from "./theme.ts";

describe("theme settings", () => {
  it("normalizes modes and accents with safe fallbacks", () => {
    expect(normalizeTheme(null)).toEqual(DEFAULT_THEME);
    expect(normalizeTheme({ mode: "neon", accent: "unknown" })).toEqual(DEFAULT_THEME);
    expect(normalizeTheme({ mode: "dark", accent: "BLUE" })).toEqual({
      mode: "dark",
      accent: "blue",
    });
    expect(normalizeTheme({ mode: "light", accent: "#A1B2C3" })).toEqual({
      mode: "light",
      accent: "#a1b2c3",
    });
    expect(normalizeAccent("#fff")).toBe("#ffffff");
    expect(normalizeAccent("#12")).toBe(DEFAULT_THEME.accent);
  });

  it("parses hex colors with or without the leading #", () => {
    expect(normalizeHex("#0ea5e9")).toBe("#0ea5e9");
    expect(normalizeHex("0EA5E9")).toBe("#0ea5e9");
    expect(normalizeHex("#abc")).toBe("#aabbcc");
    expect(normalizeHex("#abcd")).toBeNull();
    expect(normalizeHex("red")).toBeNull();
  });

  it("resolves preset colors and keeps custom colors", () => {
    expect(resolveAccentColor("violet")).toBe("#7c3aed");
    expect(resolveAccentColor("#123456")).toBe("#123456");
    expect(resolveAccentColor("bogus")).toBe(ACCENT_PRESETS[0].color);
    const ids = ACCENT_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("chooses a readable foreground for the accent background", () => {
    expect(accentContrastColor("#7c3aed")).toBe("#ffffff");
    expect(accentContrastColor("#2563eb")).toBe("#ffffff");
    expect(accentContrastColor("#fde047")).toBe("#18181b");
    expect(accentContrastColor("#ffffff")).toBe("#18181b");
  });
});
