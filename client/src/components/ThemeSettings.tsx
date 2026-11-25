import { useI18n } from "../i18n.tsx";
import { useEffect, useState } from "react";

import {
  ACCENT_PRESETS,
  THEME_MODES,
  accentContrastColor,
  normalizeHex,
  resolveAccentColor,
  type ThemeSettings as ThemeSettingsValue,
} from "../lib/theme.ts";
import { useSession } from "../session.tsx";
import { Alert, Button, Input, Label, Spinner, cn } from "./ui.tsx";

/** 모드·강조색·사용자 HEX 테마 설정. 계정에 저장된다. */
export function ThemeSettings() {
  const { t } = useI18n();
  const { theme, updateTheme } = useSession();
  const [customHex, setCustomHex] = useState(
    theme.accent.startsWith("#") ? theme.accent : resolveAccentColor(theme.accent),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setCustomHex(
      theme.accent.startsWith("#") ? theme.accent : resolveAccentColor(theme.accent),
    );
  }, [theme.accent]);

  const customSelected = theme.accent.startsWith("#");
  const preview = normalizeHex(customHex);

  async function save(next: ThemeSettingsValue): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await updateTheme(next);
      setMessage(t("theme.saved"));
    } catch {
      setError(t("theme.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <div>
        <Label>{t("theme.mode")}</Label>
        <div role="group" aria-label={t("theme.modeAria")} className="mt-1.5 flex flex-wrap gap-2">
          {THEME_MODES.map((mode) => {
            const selected = theme.mode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                aria-pressed={selected}
                disabled={busy}
                onClick={() => void save({ ...theme, mode: mode.id })}
                className={cn(
                  "rounded-lg border px-3 py-2 text-sm transition-colors disabled:opacity-60",
                  selected
                    ? "border-accent-400 bg-accent-50 text-accent-700"
                    : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50",
                )}
              >
                {mode.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <Label>{t("theme.accent")}</Label>
        <div role="group" aria-label={t("theme.accentAria")} className="mt-1.5 flex flex-wrap gap-2">
          {ACCENT_PRESETS.map((preset) => {
            const selected = theme.accent === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={selected}
                disabled={busy}
                onClick={() => void save({ ...theme, accent: preset.id })}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors disabled:opacity-60",
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
      </div>

      <div>
        <Label htmlFor="custom-accent">{t("theme.custom")}</Label>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <input
            type="color"
            aria-label={t("theme.pickColor")}
            value={preview ?? resolveAccentColor(theme.accent)}
            disabled={busy}
            onChange={(event) => setCustomHex(event.target.value)}
            className="h-10 w-12 cursor-pointer rounded-lg border border-zinc-200 bg-white p-1 disabled:opacity-60"
          />
          <Input
            id="custom-accent"
            value={customHex}
            disabled={busy}
            onChange={(event) => setCustomHex(event.target.value)}
            placeholder="#7c3aed"
            className="max-w-40 font-mono"
            spellCheck={false}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !preview}
            onClick={() => {
              if (!preview) return;
              void save({ ...theme, accent: preview });
            }}
          >
            {busy ? <Spinner /> : null}
            {t("theme.apply")}
          </Button>
          {customSelected ? (
            <span
              className="flex items-center gap-1 text-xs text-zinc-500"
              title={t("theme.contrast", { color: accentContrastColor(theme.accent) })}
            >
              <span
                className="h-3 w-3 rounded-full ring-1 ring-black/10"
                style={{ backgroundColor: resolveAccentColor(theme.accent) }}
                aria-hidden
              />
              {t("theme.inUse")}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          {t("theme.customHint")}
        </p>
        {customHex.trim().length > 0 && !preview ? (
          <p className="mt-1 text-xs text-red-600">
            {t("theme.invalidHex")}
          </p>
        ) : null}
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}
      {message ? <Alert>{message}</Alert> : null}
    </div>
  );
}
