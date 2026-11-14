import { LogOut, Settings } from "lucide-react";
import { useEffect, useState } from "react";

import { ApiError, api } from "../lib/api.ts";
import type { ConversationSummary } from "../types.ts";
import { Alert, Button, Dialog, Input, Label, Spinner } from "./ui.tsx";

export function GroupSettingsDialog({
  open,
  onClose,
  conversationId,
  currentName,
  canRename,
  onUpdated,
  onLeft,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  currentName: string;
  canRename: boolean;
  onUpdated: (name: string) => void;
  onLeft: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(currentName);
    setBusy(false);
    setError(null);
    setConfirmLeave(false);
  }, [open, currentName]);

  async function rename(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ conversation: ConversationSummary }>(
        `/api/conversations/${conversationId}/group`,
        { method: "PUT", body: { name: trimmed } },
      );
      onUpdated(response.conversation.name ?? trimmed);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "그룹 이름을 바꾸지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function leave(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/conversations/${conversationId}/members/me`, {
        method: "DELETE",
      });
      onLeft();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "그룹에서 나가지 못했습니다.");
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="그룹 설정">
      <div className="space-y-1.5">
        <Label htmlFor="group-settings-name">그룹 이름</Label>
        {canRename ? (
          <div className="flex gap-2">
            <Input
              id="group-settings-name"
              value={name}
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void rename();
                }
              }}
            />
            <Button
              onClick={() => void rename()}
              disabled={busy || !name.trim() || name.trim() === currentName}
              className="shrink-0"
            >
              {busy ? <Spinner /> : <Settings className="h-4 w-4" aria-hidden />}
              이름 저장
            </Button>
          </div>
        ) : (
          <>
            <p className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700">
              {currentName}
            </p>
            <p className="text-xs text-zinc-500">
              그룹 이름 변경과 참여자 추가는 그룹 소유자만 할 수 있습니다.
            </p>
          </>
        )}
      </div>

      {error ? (
        <div className="mt-3">
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}

      <div className="mt-5 border-t border-zinc-100 pt-4">
        <p className="text-sm font-medium text-zinc-900">그룹 나가기</p>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          나가면 이 대화가 목록에서 사라지고 새 메시지를 받지 않습니다. 내가 보낸
          메시지는 다른 참여자에게 남습니다.
        </p>
        {confirmLeave ? (
          <div className="mt-3 flex gap-2">
            <Button variant="destructive" size="sm" onClick={() => void leave()} disabled={busy}>
              {busy ? <Spinner /> : <LogOut className="h-4 w-4" aria-hidden />}
              정말 나가기
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmLeave(false)}
              disabled={busy}
            >
              취소
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => setConfirmLeave(true)}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            그룹 나가기
          </Button>
        )}
      </div>
    </Dialog>
  );
}
