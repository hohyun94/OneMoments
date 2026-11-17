import type { UserRow } from "../db/schema.js";
import type { ThemeMode, ThemeSettings } from "../types/protocol.js";

export const THEME_MODES: ThemeMode[] = ["light", "dark", "system"];
export const THEME_ACCENTS = ["violet", "blue", "emerald", "rose", "amber"] as const;

export function toThemeSettings(user: UserRow): ThemeSettings {
  const mode = THEME_MODES.includes(user.themeMode as ThemeMode)
    ? (user.themeMode as ThemeMode)
    : "system";
  return { mode, accent: user.themeAccent };
}
