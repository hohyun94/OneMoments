/** 화면 테마(모드·강조색). 계정에 저장되며 로컬에도 캐시한다. */
export type ThemeMode = "light" | "dark" | "system";

export interface ThemeSettings {
  mode: ThemeMode;
  /** 프리셋 ID 또는 #rrggbb */
  accent: string;
}

export const THEME_STORAGE_KEY = "onemoments:theme";
const LEGACY_ACCENT_STORAGE_KEY = "onemoments:accent";

export const THEME_MODES: Array<{ id: ThemeMode; label: string }> = [
  { id: "light", label: "라이트" },
  { id: "dark", label: "다크" },
  { id: "system", label: "시스템" },
];

export const ACCENT_PRESETS = [
  { id: "violet", label: "바이올렛", color: "#7c3aed" },
  { id: "blue", label: "블루", color: "#2563eb" },
  { id: "emerald", label: "에메랄드", color: "#047857" },
  { id: "rose", label: "로즈", color: "#be123c" },
  { id: "amber", label: "앰버", color: "#b45309" },
] as const;

export type AccentId = (typeof ACCENT_PRESETS)[number]["id"];

export const DEFAULT_ACCENT: AccentId = "violet";
export const DEFAULT_THEME: ThemeSettings = { mode: "system", accent: DEFAULT_ACCENT };

export function normalizeHex(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  if (/^[0-9a-f]{6}$/.test(trimmed)) return `#${trimmed}`;
  return null;
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && normalizeHex(value) !== null;
}

export function normalizeAccent(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (ACCENT_PRESETS.some((preset) => preset.id === normalized)) return normalized;
    const hex = normalizeHex(normalized);
    if (hex) return hex;
  }
  return DEFAULT_ACCENT;
}

export function normalizeTheme(value: unknown): ThemeSettings {
  if (value && typeof value === "object") {
    const candidate = value as { mode?: unknown; accent?: unknown };
    const mode = THEME_MODES.some((item) => item.id === candidate.mode)
      ? (candidate.mode as ThemeMode)
      : DEFAULT_THEME.mode;
    return { mode, accent: normalizeAccent(candidate.accent) };
  }
  return DEFAULT_THEME;
}

export function accentPreset(id: string) {
  return ACCENT_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function resolveAccentColor(accent: string): string {
  return accentPreset(accent)?.color ?? normalizeHex(accent) ?? ACCENT_PRESETS[0].color;
}

/** 강조색 배경 위에 올릴 글자색. 대비가 부족하면 어두운 색을 쓴다. */
export function accentContrastColor(hex: string): "#ffffff" | "#18181b" {
  const normalized = normalizeHex(hex) ?? ACCENT_PRESETS[0].color;
  const channel = (offset: number) => {
    const value = parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return 1.05 / (luminance + 0.05) >= 4.5 ? "#ffffff" : "#18181b";
}

export function loadTheme(): ThemeSettings {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) return normalizeTheme(JSON.parse(raw));
    // 이전 버전의 강조색 단일 키에서 마이그레이션한다.
    const legacy = window.localStorage.getItem(LEGACY_ACCENT_STORAGE_KEY);
    if (legacy) return { mode: DEFAULT_THEME.mode, accent: normalizeAccent(legacy) };
  } catch {
    // 접근이 막힌 브라우저는 기본값을 쓴다.
  }
  return DEFAULT_THEME;
}

export function saveTheme(value: ThemeSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(normalizeTheme(value)));
  } catch {
    // 저장이 막혀도 현재 화면에는 적용한다.
  }
}

export interface ApplyThemeOptions {
  /** 기본값 true. false 면 localStorage 를 건드리지 않는다. */
  persist?: boolean;
}

/**
 * html 에 테마 클래스/변수를 적용한다.
 * - 다크 모드: html.dark
 * - 강조색: 프리셋은 data-accent, 사용자 HEX 는 --accent-base 인라인 변수
 */
export function applyTheme(value: ThemeSettings, options: ApplyThemeOptions = {}): ThemeSettings {
  const theme = normalizeTheme(value);
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    const preset = accentPreset(theme.accent);

    if (preset) {
      root.dataset.accent = preset.id;
      root.style.removeProperty("--accent-base");
      root.style.removeProperty("--accent-contrast");
    } else {
      const color = resolveAccentColor(theme.accent);
      root.dataset.accent = "custom";
      root.style.setProperty("--accent-base", color);
      root.style.setProperty("--accent-contrast", accentContrastColor(color));
    }

    const prefersDark =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = theme.mode === "dark" || (theme.mode === "system" && prefersDark);
    root.classList.toggle("dark", dark);
    root.dataset.themeMode = theme.mode;

    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = dark ? "#09090b" : "#fafafa";
  }

  if (options.persist ?? true) saveTheme(theme);
  return theme;
}
