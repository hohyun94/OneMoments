import { Search } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { ApiError, api } from "../lib/api.ts";
import type { ConversationSummary, PeerUser } from "../types.ts";
import { Alert, Button, Dialog, Input, Label, Spinner } from "./ui.tsx";

export function NewConversationDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [result, setResult] = useState<PeerUser | null>(null);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUsername("");
    setResult(null);
    setSearched(false);
    setError(null);
  }, [open]);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = username.trim();
    if (!query) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ user: PeerUser | null }>(
        `/api/users/search?username=${encodeURIComponent(query)}`,
      );
      setResult(response.user);
      setSearched(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "검색에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ conversation: ConversationSummary }>("/api/conversations", {
        method: "POST",
        body: { peerUserId: result.id },
      });
      onCreated(response.conversation.id);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "대화를 시작할 수 없습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="새 대화">
      <form className="space-y-3" onSubmit={search}>
        <div className="space-y-1.5">
          <Label htmlFor="peer-username">사용자 아이디</Label>
          <div className="flex gap-2">
            <Input
              id="peer-username"
              autoFocus
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setSearched(false);
                setResult(null);
              }}
              placeholder="정확한 아이디 입력"
            />
            <Button type="submit" variant="outline" disabled={busy} aria-label="검색">
              {busy ? <Spinner /> : <Search className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </form>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {searched && !result ? (
        <p className="mt-3 text-sm text-zinc-500">일치하는 사용자가 없습니다.</p>
      ) : null}

      {result ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-zinc-200 p-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-900">@{result.username}</p>
            <p className="text-xs text-zinc-500">종단간 암호화 1:1 대화</p>
          </div>
          <Button onClick={start} disabled={busy}>
            {busy ? <Spinner /> : null}
            대화 시작
          </Button>
        </div>
      ) : null}

      <p className="mt-4 text-xs text-zinc-500">
        상대가 오프라인이어도 메시지는 암호화되어 저장되고, 접속하면 전달됩니다.
      </p>
    </Dialog>
  );
}
