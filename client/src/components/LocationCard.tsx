import { ExternalLink, MapPin } from "lucide-react";

import {
  formatAccuracy,
  formatCoordinates,
  locationMapLink,
  type LocationPayload,
} from "../lib/location.ts";
import { cn } from "./ui.tsx";

/** 암호화된 위치 공유 메시지를 카드로 보여준다(지도 임베드 없이 외부 링크만). */
export function LocationCard({ location, own }: { location: LocationPayload; own: boolean }) {
  const title = location.label?.trim() || "공유한 위치";
  return (
    <div
      data-testid="location-card"
      className={cn(
        "max-w-[16rem] rounded-xl border p-2.5",
        own ? "border-accent-400/40 bg-accent-500/20" : "border-zinc-200 bg-zinc-50",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
            own ? "bg-white/25 text-accent-contrast" : "bg-accent-100 text-accent-700",
          )}
        >
          <MapPin className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          <p
            data-testid="location-coordinates"
            className={cn(
              "font-mono text-[11px]",
              own ? "text-accent-contrast/80" : "text-zinc-600",
            )}
          >
            {formatCoordinates(location)}
          </p>
          <p className={cn("text-[11px]", own ? "text-accent-contrast/80" : "text-zinc-500")}>
            {formatAccuracy(location.accuracy)}
          </p>
        </div>
      </div>
      <a
        href={locationMapLink(location)}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "mt-2 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2",
          own ? "text-white" : "text-accent-700",
        )}
      >
        지도에서 열기
        <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </div>
  );
}
