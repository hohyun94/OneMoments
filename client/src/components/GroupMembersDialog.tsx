import { Search, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { ApiError, api } from "../lib/api.ts";
import type { PeerUser } from "../types.ts";
import { Alert, Button, Dialog, Input, Label, Spinner } from "./ui.tsx";

export function GroupMembersDialog({
  open,
  onClose,
  conversationId,
  existingMemberIds,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  existingMemberIds: string[];
  onAdded: () => void;
}) {
  const [username, setUsername] = useState("");
  const [result, setResult] = useState<PeerUser | null>(null);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<PeerUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUsername("");
    setResult(null);
    setSearched(false);
    setSelected([]);
    setError(null);
    setBusy(false);
  }, [open]);

  async function search(event: FormEvent<HTMLFormElement>): Promise<void> {
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

  function add(): void {
    if (!result) return;
    if (existingMemberIds.includes(result.id)) return;
    if (selected.some((member) => member.id === result.id)) return;
    setSelected((current) => [...current, result]);
    setUsername("");
    setResult(null);
    setSearched(false);
    setError(null);
  }

  async function submit(): Promise<void> {
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/conversations/${conversationId}/members`, {
        method: "POST",
        body: { userIds: selected.map((member) => member.id) },
      });
      onAdded();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "참여자를 추가할 수 없습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="참여자 추가">
      <form className="space-y-3" onSubmit={search}>
        <div className="space-y-1.5">
          <Label htmlFor="member-username">사용자 아이디</Label>
          <div className="flex gap-2">
            <Input
              id="member-username"
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
          <p className="min-w-0 truncate text-sm font-medium text-zinc-900">@{result.username}</p>
          {existingMemberIds.includes(result.id) ? (
            <span className="shrink-0 text-xs text-zinc-500">이미 참여 중</span>
          ) : (
            <Button size="sm" onClick={add} disabled={busy}>
              추가
            </Button>
          )}
        </div>
      ) : null}

      {selected.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {selected.map((member) => (
            <li
              key={member.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 px-3 py-2"
            >
              <span className="truncate text-sm text-zinc-900">@{member.username}</span>
              <button
                type="button"
                aria-label={`${member.username} 제거`}
                onClick={() =>
                  setSelected((current) => current.filter((item) => item.id !== member.id))
                }
                className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <Button className="mt-4 w-full" onClick={submit} disabled={busy || selected.length === 0}>
        {busy ? <Spinner /> : null}
        참여자 추가하기
      </Button>
      <p className="mt-3 text-xs text-zinc-500">
        새 참여자는 추가 이후 메시지만 읽을 수 있습니다. 기존 이력은 각 기기에 암호화되어 있어
        새 기기로 전달되지 않습니다.
      </p>
    </Dialog>
  );
}
