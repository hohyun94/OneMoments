import { Search, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { ApiError, api } from "../lib/api.ts";
import type { ConversationSummary, PeerUser } from "../types.ts";
import { Alert, Button, Dialog, Input, Label, Spinner, cn } from "./ui.tsx";

type Mode = "direct" | "group";

export function NewConversationDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("direct");
  const [username, setUsername] = useState("");
  const [result, setResult] = useState<PeerUser | null>(null);
  const [searched, setSearched] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [members, setMembers] = useState<PeerUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode("direct");
    setUsername("");
    setResult(null);
    setSearched(false);
    setGroupName("");
    setMembers([]);
    setError(null);
    setBusy(false);
  }, [open]);

  function switchMode(next: Mode): void {
    if (next === mode) return;
    setMode(next);
    setUsername("");
    setResult(null);
    setSearched(false);
    setError(null);
  }

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

  function addMember(): void {
    if (!result || members.some((member) => member.id === result.id)) return;
    setMembers((current) => [...current, result]);
    setUsername("");
    setResult(null);
    setSearched(false);
    setError(null);
  }

  function removeMember(id: string): void {
    setMembers((current) => current.filter((member) => member.id !== id));
  }

  async function create(body: Record<string, unknown>, fallback: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ conversation: ConversationSummary }>("/api/conversations", {
        method: "POST",
        body,
      });
      onCreated(response.conversation.id);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  function startDirect(): void {
    if (!result) return;
    void create({ peerUserId: result.id }, "대화를 시작할 수 없습니다.");
  }

  function createGroup(): void {
    if (!groupName.trim() || members.length === 0) return;
    void create(
      {
        kind: "group",
        name: groupName.trim(),
        memberUserIds: members.map((member) => member.id),
      },
      "그룹을 만들 수 없습니다.",
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="새 대화">
      <div
        role="tablist"
        aria-label="대화 종류"
        className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === "direct"}
          onClick={() => switchMode("direct")}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            mode === "direct" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600",
          )}
        >
          1:1
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "group"}
          onClick={() => switchMode("group")}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            mode === "group" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600",
          )}
        >
          그룹
        </button>
      </div>

      {mode === "group" ? (
        <div className="mb-3 space-y-1.5">
          <Label htmlFor="group-name">그룹 이름</Label>
          <Input
            id="group-name"
            value={groupName}
            maxLength={64}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder="예: 주말 등산"
          />
        </div>
      ) : null}

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
            <p className="text-xs text-zinc-500">
              {mode === "group" ? "그룹에 추가할 사용자" : "1:1 대화"}
            </p>
          </div>
          <Button
            onClick={mode === "group" ? addMember : startDirect}
            disabled={busy}
          >
            {busy ? <Spinner /> : null}
            {mode === "group" ? "추가" : "대화 시작"}
          </Button>
        </div>
      ) : null}

      {mode === "group" ? (
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-zinc-700">
              참여자 {members.length + 1}명
            </p>
            <p className="text-xs text-zinc-500">최대 20명</p>
          </div>
          <ul className="mt-2 space-y-2">
            {members.map((member) => (
              <li
                key={member.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 px-3 py-2"
              >
                <span className="truncate text-sm text-zinc-900">@{member.username}</span>
                <button
                  type="button"
                  onClick={() => removeMember(member.id)}
                  aria-label={`${member.username} 제거`}
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
            {members.length === 0 ? (
              <li className="rounded-lg border border-dashed border-zinc-200 px-3 py-3 text-center text-xs text-zinc-500">
                아이디를 검색해 참여자를 추가하세요.
              </li>
            ) : null}
          </ul>
          <Button
            className="mt-4 w-full"
            onClick={createGroup}
            disabled={busy || !groupName.trim() || members.length === 0}
          >
            {busy ? <Spinner /> : null}
            그룹 만들기
          </Button>
        </div>
      ) : null}

      <p className="mt-4 text-xs text-zinc-500">
        {mode === "group"
          ? "그룹 메시지는 참여자 전원의 기기로 각각 암호화되어 전송됩니다. 새로 참여한 사람은 이후 메시지만 읽을 수 있습니다."
          : "상대가 오프라인이어도 메시지는 암호화되어 저장되고, 접속하면 전달됩니다."}
      </p>
    </Dialog>
  );
}
