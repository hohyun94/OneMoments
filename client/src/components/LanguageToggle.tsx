import { Languages } from "lucide-react";

import { useI18n } from "../i18n.tsx";
import { cn } from "./ui.tsx";

/** 한국어/English 전환(선택은 브라우저에 저장). */
export function LanguageToggle({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div
      role="group"
      aria-label="Language"
      className={cn("inline-flex items-center gap-1 rounded-lg bg-zinc-100 p-1", className)}
    >
      <Languages className="ml-1 h-3.5 w-3.5 text-zinc-500" aria-hidden />
      {(["ko", "en"] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => setLocale(value)}
          aria-pressed={locale === value}
          className={cn(
            "rounded-md px-2 py-1 text-[11px] font-medium",
            locale === value
              ? "bg-white text-zinc-900 shadow-sm"
              : "text-zinc-500 hover:text-zinc-700",
          )}
        >
          {t(`lang.${value}`)}
        </button>
      ))}
    </div>
  );
}
