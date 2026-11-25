import { useQuery } from "@tanstack/react-query";
import { PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from "lucide-react";

import { useI18n } from "../i18n.tsx";
import { api } from "../lib/api.ts";
import { callLogLabel } from "../lib/call.ts";
import { formatClock } from "../lib/format.ts";
import { formatDuration } from "../lib/voice.ts";
import type { CallLogEntry } from "../types.ts";
import { Dialog, Spinner, cn } from "./ui.tsx";

/** 1:1 대화의 통화 기록(메타데이터만) 목록. */
export function CallHistoryDialog({
  open,
  onClose,
  conversationId,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
}) {
  const query = useQuery({
    queryKey: ["call-logs", conversationId],
    queryFn: () =>
      api<{ calls: CallLogEntry[] }>(`/api/conversations/${conversationId}/calls`).then(
        (response) => response.calls,
      ),
    enabled: open,
    staleTime: 10_000,
  });
  const calls = query.data ?? [];
  const { t, locale } = useI18n();

  return (
    <Dialog open={open} onClose={onClose} title={t("chat.callHistory")}>
      {query.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : calls.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">{t("call.empty")}</p>
      ) : (
        <ul className="max-h-80 space-y-2 overflow-y-auto">
          {calls.map((entry) => {
            const missed = entry.status === "missed";
            const Icon =
              entry.media === "video"
                ? Video
                : missed
                  ? PhoneMissed
                  : entry.direction === "incoming"
                    ? PhoneIncoming
                    : PhoneOutgoing;
            return (
              <li
                key={entry.id}
                className="flex items-center gap-2.5 rounded-lg border border-zinc-200 px-3 py-2"
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                    missed ? "bg-red-50 text-red-600" : "bg-accent-100 text-accent-700",
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block text-sm font-medium",
                      missed ? "text-red-600" : "text-zinc-900",
                    )}
                  >
                    {callLogLabel(entry)}
                  </span>
                  <span className="block text-[11px] text-zinc-500">
                    {formatClock(entry.startedAt, locale)}
                    {entry.durationSeconds !== null
                      ? ` · ${formatDuration(entry.durationSeconds)}`
                      : ""}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
