import { Clock } from "lucide-react";
import { useEffect, useState } from "react";

import { ApiError, api } from "../lib/api.ts";
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
          : "자동 삭제 설정을 저장하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="자동 삭제">
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-zinc-600">
          참여자 모두가 메시지를 읽은 뒤 선택한 기간이 지나면 서버에서 메시지와 첨부가
          삭제됩니다. 한 명이라도 읽지 않은 메시지는 삭제되지 않으며, 삭제된 메시지는
          복구할 수 없습니다.
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="auto-delete-select" className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-zinc-500" aria-hidden />
            읽은 뒤 삭제
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
            ? "그룹에서는 소유자만 변경할 수 있으며, 변경 내용은 모든 참여자에게 적용됩니다."
            : "1:1 대화의 설정은 상대에게도 함께 적용됩니다."}{" "}
          삭제는 주기적 정리와 조회 시점에 실행되므로 최대 몇 분 지연될 수 있습니다.
        </p>

        {!canEdit ? (
          <Alert>그룹 소유자만 이 설정을 변경할 수 있습니다.</Alert>
        ) : null}
        {error ? <Alert variant="error">{error}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!canEdit || busy}>
            {busy ? <Spinner /> : null}
            저장
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
