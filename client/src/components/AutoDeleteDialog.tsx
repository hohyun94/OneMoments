import { Clock } from "lucide-react";
import { useEffect, useState } from "react";

import { ApiError, api } from "../lib/api.ts";
import { useI18n } from "../i18n.tsx";
import { AUTO_DELETE_OPTIONS, autoDeleteLabel } from "../lib/autoDelete.ts";
import type { ConversationSummary } from "../types.ts";
import { Alert, Button, Dialog, Label, Spinner } from "./ui.tsx";

export function AutoDeleteDialog({
  open,
  onClose,
  conversationId,
  initialSeconds,
  isGroup,
  canEdit,
  onUpdated,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  initialSeconds: number | null;
  isGroup: boolean;
  canEdit: boolean;
  onUpdated: (seconds: number | null) => void;
}) {
  const [seconds, setSeconds] = useState<number | null>(initialSeconds);
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSeconds(initialSeconds);
    setBusy(false);
    setError(null);
  }, [open, initialSeconds]);

  const options: Array<{ seconds: number | null; label: string }> = [
    ...AUTO_DELETE_OPTIONS,
  ];
  if (
    initialSeconds !== null &&
    !options.some((option) => option.seconds === initialSeconds)
  ) {
    options.push({ seconds: initialSeconds, label: autoDeleteLabel(initialSeconds) });
  }

  async function save(): Promise<void> {
    if (!canEdit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ conversation: ConversationSummary }>(
        `/api/conversations/${conversationId}/auto-delete`,
        { method: "PUT", body: { seconds } },
      );
      onUpdated(response.conversation.autoDeleteAfterReadSeconds);
      onClose();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : t("autoDelete.saveFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("autoDelete.title")}>
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-zinc-600">
          {t("autoDelete.description")}
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="auto-delete-select" className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-zinc-500" aria-hidden />
            {t("autoDelete.label")}
          </Label>
          <select
            id="auto-delete-select"
            className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 focus:border-accent-400 focus:outline-none focus:ring-2 focus:ring-accent-100 disabled:opacity-50"
            value={seconds === null ? "off" : String(seconds)}
            disabled={!canEdit || busy}
            onChange={(event) =>
              setSeconds(event.target.value === "off" ? null : Number(event.target.value))
            }
          >
            {options.map((option) => (
              <option
                key={option.label}
                value={option.seconds === null ? "off" : String(option.seconds)}
              >
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <p className="text-xs leading-relaxed text-zinc-500">
          {isGroup
            ? t("autoDelete.groupNote")
            : t("autoDelete.directNote")}{" "}
          {t("autoDelete.delayNote")}
        </p>

        {!canEdit ? (
          <Alert>{t("autoDelete.ownerOnly")}</Alert>
        ) : null}
        {error ? <Alert variant="error">{error}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t("chat.cancel")}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!canEdit || busy}>
            {busy ? <Spinner /> : null}
            {t("chat.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
