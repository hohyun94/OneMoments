/** 강조색 테마(로컬 브라우저 설정). 서버에 저장하지 않는다. */
export const ACCENT_STORAGE_KEY = "onemoments:accent";

export const ACCENT_PRESETS = [
  { id: "violet", label: "바이올렛", color: "#7c3aed" },
  { id: "blue", label: "블루", color: "#2563eb" },
  { id: "emerald", label: "에메랄드", color: "#047857" },
  { id: "rose", label: "로즈", color: "#be123c" },
  { id: "amber", label: "앰버", color: "#b45309" },
] as const;

export type AccentId = (typeof ACCENT_PRESETS)[number]["id"];

export const DEFAULT_ACCENT: AccentId = "violet";

export function normalizeAccent(value: unknown): AccentId {
  return ACCENT_PRESETS.some((preset) => preset.id === value)
    ? (value as AccentId)
    : DEFAULT_ACCENT;
}

export function accentPreset(id: AccentId) {
  return ACCENT_PRESETS.find((preset) => preset.id === id) ?? ACCENT_PRESETS[0];
}

export function loadAccent(): AccentId {
  if (typeof window === "undefined") return DEFAULT_ACCENT;
  try {
    return normalizeAccent(window.localStorage.getItem(ACCENT_STORAGE_KEY));
  } catch {
    return DEFAULT_ACCENT;
  }
}

/** html[data-accent] 를 갱신하고(선택) localStorage 에 저장한다. */
export function applyAccent(id: AccentId, persist = true): void {
  const accent = normalizeAccent(id);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.accent = accent;
  }
  if (!persist || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    // 저장이 막혀도 현재 화면에는 적용한다.
  }
}
