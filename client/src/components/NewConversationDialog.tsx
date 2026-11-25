import { Search, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { useI18n } from "../i18n.tsx";
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
  const { t } = useI18n();

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
      setError(caught instanceof ApiError ? caught.message : t("error.searchFailed"));
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
    void create({ peerUserId: result.id }, t("error.startConversation"));
  }

  function createGroup(): void {
    if (!groupName.trim() || members.length === 0) return;
    void create(
      {
        kind: "group",
        name: groupName.trim(),
        memberUserIds: members.map((member) => member.id),
      },
      t("error.createGroup"),
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("newChat.title")}>
      <div
        role="tablist"
        aria-label={t("newChat.kind.label")}
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
          {t("newChat.tab.group")}
        </button>
      </div>

      {mode === "group" ? (
        <div className="mb-3 space-y-1.5">
          <Label htmlFor="group-name">{t("newChat.groupName.label")}</Label>
          <Input
            id="group-name"
            value={groupName}
            maxLength={64}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder={t("newChat.groupName.placeholder")}
          />
        </div>
      ) : null}

      <form className="space-y-3" onSubmit={search}>
        <div className="space-y-1.5">
          <Label htmlFor="peer-username">{t("newChat.username.label")}</Label>
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
              placeholder={t("newChat.username.placeholder")}
            />
            <Button type="submit" variant="outline" disabled={busy} aria-label={t("newChat.search")}>
              {busy ? <Spinner /> : <Search className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </form>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {searched && !result ? (
        <p className="mt-3 text-sm text-zinc-500">{t("newChat.notFound")}</p>
      ) : null}

      {result ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-zinc-200 p-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-900">@{result.username}</p>
            <p className="text-xs text-zinc-500">
              {mode === "group" ? t("newChat.result.group") : t("newChat.result.direct")}
            </p>
          </div>
          <Button
            onClick={mode === "group" ? addMember : startDirect}
            disabled={busy}
          >
            {busy ? <Spinner /> : null}
            {mode === "group" ? t("newChat.add") : t("newChat.start")}
          </Button>
        </div>
      ) : null}

      {mode === "group" ? (
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-zinc-700">
              {t("newChat.members", { count: members.length + 1 })}
            </p>
            <p className="text-xs text-zinc-500">{t("newChat.maxMembers")}</p>
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
                  aria-label={t("newChat.removeMember", { name: member.username ?? "" })}
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
            {members.length === 0 ? (
              <li className="rounded-lg border border-dashed border-zinc-200 px-3 py-3 text-center text-xs text-zinc-500">
                {t("newChat.membersEmpty")}
              </li>
            ) : null}
          </ul>
          <Button
            className="mt-4 w-full"
            onClick={createGroup}
            disabled={busy || !groupName.trim() || members.length === 0}
          >
            {busy ? <Spinner /> : null}
            {t("newChat.createGroup")}
          </Button>
        </div>
      ) : null}

      <p className="mt-4 text-xs text-zinc-500">
        {mode === "group" ? t("newChat.groupNote") : t("newChat.directNote")}
      </p>
    </Dialog>
  );
}
