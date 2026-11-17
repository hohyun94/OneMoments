import { describe, expect, it } from "vitest";

import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  accentPreset,
  normalizeAccent,
} from "./theme.ts";

describe("accent theme", () => {
  it("falls back to the default for unknown or missing values", () => {
    expect(normalizeAccent(null)).toBe(DEFAULT_ACCENT);
    expect(normalizeAccent("")).toBe(DEFAULT_ACCENT);
    expect(normalizeAccent("neon")).toBe(DEFAULT_ACCENT);
    expect(normalizeAccent("blue")).toBe("blue");
  });

  it("defines unique presets with accessible base colors", () => {
    const ids = ACCENT_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of ACCENT_PRESETS) {
      expect(preset.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(accentPreset(preset.id).label).toBe(preset.label);
    }
  });
});
