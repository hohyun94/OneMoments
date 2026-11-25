import { Link2, LogOut, Mail, Settings } from "lucide-react";
import { useEffect, useState } from "react";

import { ApiError, api } from "../lib/api.ts";
import { useI18n } from "../i18n.tsx";
import { inviteMailto } from "../lib/inviteMail.ts";
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
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(currentName);
    setBusy(false);
    setError(null);
    setConfirmLeave(false);
    setInviteUrl(null);
    setInviteBusy(false);
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
      setError(caught instanceof ApiError ? caught.message : t("group.renameFailed"));
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
      setError(caught instanceof ApiError ? caught.message : t("group.leaveFailed"));
      setBusy(false);
    }
  }

  async function createInvite(): Promise<void> {
    if (inviteBusy) return;
    setInviteBusy(true);
    setError(null);
    try {
      const response = await api<{ invite: { token: string } }>(
        `/api/conversations/${conversationId}/invites`,
        { method: "POST", body: {} },
      );
      const url = `${window.location.origin}/join/${response.invite.token}`;
      setInviteUrl(url);
      await navigator.clipboard.writeText(url).catch(() => undefined);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : t("group.inviteFailed"),
      );
    } finally {
      setInviteBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("group.title")}>
      <div className="space-y-1.5">
        <Label htmlFor="group-settings-name">{t("group.nameLabel")}</Label>
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
              {t("group.saveName")}
            </Button>
          </div>
        ) : (
          <>
            <p className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700">
              {currentName}
            </p>
            <p className="text-xs text-zinc-500">
              {t("group.ownerNote")}
            </p>
          </>
        )}
      </div>

      {error ? (
        <div className="mt-3">
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}

      {canRename ? (
        <div className="mt-5 border-t border-zinc-100 pt-4">
          <p className="text-sm font-medium text-zinc-900">{t("group.inviteTitle")}</p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            {t("group.inviteNote")}
          </p>
          {inviteUrl ? (
            <div className="mt-3 space-y-2">
              <div className="flex gap-2">
                <Input readOnly value={inviteUrl} aria-label={t("group.inviteAria")} />
                <Button
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void navigator.clipboard.writeText(inviteUrl)}
                >
                  <Link2 className="h-4 w-4" aria-hidden />
                  {t("group.copy")}
                </Button>
              </div>
              {/* 서버가 메일을 보내지 않고, 사용자의 메일 클라이언트로 초대 링크를 전달한다. */}
              <a
                href={inviteMailto(inviteUrl, { groupName: currentName })}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-700 hover:underline"
              >
                <Mail className="h-3.5 w-3.5" aria-hidden />
                {t("group.email")}
              </a>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void createInvite()}
              disabled={inviteBusy}
            >
              {inviteBusy ? <Spinner /> : <Link2 className="h-4 w-4" aria-hidden />}
              {t("group.createInvite")}
            </Button>
          )}
        </div>
      ) : null}

      <div className="mt-5 border-t border-zinc-100 pt-4">
        <p className="text-sm font-medium text-zinc-900">{t("group.leaveTitle")}</p>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          {t("group.leaveNote")}
        </p>
        {confirmLeave ? (
          <div className="mt-3 flex gap-2">
            <Button variant="destructive" size="sm" onClick={() => void leave()} disabled={busy}>
              {busy ? <Spinner /> : <LogOut className="h-4 w-4" aria-hidden />}
              {t("group.confirmLeave")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmLeave(false)}
              disabled={busy}
            >
              {t("chat.cancel")}
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
            {t("group.leave")}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
