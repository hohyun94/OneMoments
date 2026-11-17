import { useEffect, useState } from "react";

import {
  ACCENT_PRESETS,
  ACCENT_STORAGE_KEY,
  applyAccent,
  loadAccent,
  normalizeAccent,
  type AccentId,
} from "../lib/theme.ts";
import { cn } from "./ui.tsx";

/** 강조색 프리셋 선택. 설정은 이 브라우저(localStorage)에만 저장된다. */
export function AccentPicker() {
  const [accent, setAccent] = useState<AccentId>(() => loadAccent());

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== ACCENT_STORAGE_KEY) return;
      const next = normalizeAccent(event.newValue);
      applyAccent(next, false);
      setAccent(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return (
    <div role="group" aria-label="강조색" className="mt-3 flex flex-wrap gap-2">
      {ACCENT_PRESETS.map((preset) => {
        const selected = accent === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              applyAccent(preset.id);
              setAccent(preset.id);
            }}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
              selected
                ? "border-accent-400 bg-accent-50 text-accent-700"
                : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50",
            )}
          >
            <span
              className="h-4 w-4 rounded-full ring-1 ring-black/10"
              style={{ backgroundColor: preset.color }}
              aria-hidden
            />
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}
