import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Ban,
  Check,
  ImagePlus,
  Link2,
  Mail,
  MessageSquare,
  Star,
  UserRound,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  Alert,
  Avatar,
  Button,
  Card,
  Dialog,
  Input,
  Spinner,
  cn,
} from "../components/ui.tsx";
import { useI18n } from "../i18n.tsx";
import { api } from "../lib/api.ts";
import { validateAvatarFile } from "../lib/avatar.ts";
import { appInviteLink, inviteMailto } from "../lib/inviteMail.ts";
import { useSession } from "../session.tsx";
import type { ContactView } from "../types.ts";

export function ContactsPage() {
  const { session, updateStatusMessage, uploadAvatar, removeAvatar, updateLastSeenVisibility } =
    useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [statusDraft, setStatusDraft] = useState(session?.user.statusMessage ?? "");
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [lastSeenBusy, setLastSeenBusy] = useState(false);
  const [lastSeenError, setLastSeenError] = useState<string | null>(null);
  const [blockTarget, setBlockTarget] = useState<ContactView | null>(null);

  useEffect(() => {
    setStatusDraft(session?.user.statusMessage ?? "");
  }, [session?.user.statusMessage]);

  const contactsQuery = useQuery({
    queryKey: ["contacts"],
    queryFn: () =>
      api<{ contacts: ContactView[] }>("/api/contacts").then(
        (response) => response.contacts,
      ),
    enabled: Boolean(session),
  });

  function invalidateContactData(): void {
    void queryClient.invalidateQueries({ queryKey: ["contacts"] });
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  }

  const favoriteMutation = useMutation({
    mutationFn: (input: { userId: string; favorite: boolean }) =>
      api(`/api/contacts/${input.userId}/favorite`, {
        method: "PUT",
        body: { favorite: input.favorite },
      }),
    onSuccess: invalidateContactData,
  });

  const blockMutation = useMutation({
    mutationFn: (input: { userId: string; blocked: boolean }) =>
      api(`/api/contacts/${input.userId}/block`, {
        method: "PUT",
        body: { blocked: input.blocked },
      }),
    onSuccess: () => {
      setBlockTarget(null);
      invalidateContactData();
    },
  });

  const openMutation = useMutation({
    mutationFn: (userId: string) =>
      api<{ conversation: { id: string } }>("/api/conversations", {
        method: "POST",
        body: { peerUserId: userId },
      }),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      navigate(`/c/${response.conversation.id}`);
    },
  });

  if (!session) return null;
  const contacts = contactsQuery.data ?? [];
  const appLink = appInviteLink(window.location.origin);

  async function saveStatus(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatusBusy(true);
    setStatusError(null);
    setStatusMessage(null);
    try {
      await updateStatusMessage(statusDraft.trim() || null);
      setStatusMessage(t("contacts.statusSaved"));
    } catch {
      setStatusError(t("contacts.statusFailed"));
    } finally {
      setStatusBusy(false);
    }
  }

  async function changeAvatar(file: File | undefined): Promise<void> {
    if (!file) return;
    const problem = validateAvatarFile(file);
    setAvatarMessage(null);
    setAvatarError(null);
    if (problem) {
      setAvatarError(problem);
      return;
    }
    setAvatarBusy(true);
    try {
      await uploadAvatar(file);
      setAvatarMessage(t("contacts.avatarSaved"));
    } catch {
      setAvatarError(t("contacts.avatarSaveFailed"));
    } finally {
      setAvatarBusy(false);
    }
  }

  async function clearAvatar(): Promise<void> {
    setAvatarMessage(null);
    setAvatarError(null);
    setAvatarBusy(true);
    try {
      await removeAvatar();
      setAvatarMessage(t("contacts.avatarRemoved"));
    } catch {
      setAvatarError(t("contacts.avatarRemoveFailed"));
    } finally {
      setAvatarBusy(false);
    }
  }

  async function toggleLastSeen(visible: boolean): Promise<void> {
    setLastSeenError(null);
    setLastSeenBusy(true);
    try {
      await updateLastSeenVisibility(visible);
    } catch {
      setLastSeenError(t("contacts.settingsFailed"));
    } finally {
      setLastSeenBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/")}
            aria-label={t("contacts.back")}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold text-zinc-900">{t("contacts.title")}</h1>
            <p className="text-xs text-zinc-500">{t("contacts.subtitle")}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-5 px-4 py-6">
        <Card className="p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <UserRound className="h-4 w-4 text-accent-600" aria-hidden />
            {t("contacts.myProfile")}
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            {t("contacts.privacyNote", { username: `@${session.user.username}` })}
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Avatar
              name={session.user.username}
              userId={session.user.id}
              avatarUpdatedAt={session.user.avatarUpdatedAt}
              className="h-14 w-14 text-lg"
            />
            <div className="flex flex-wrap items-center gap-2">
              <label
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50",
                  avatarBusy && "pointer-events-none opacity-50",
                )}
              >
                <ImagePlus className="h-3.5 w-3.5" aria-hidden />
                {t("contacts.pickPhoto")}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  aria-label={t("contacts.pickPhotoAria")}
                  className="sr-only"
                  disabled={avatarBusy}
                  onChange={(event) => {
                    void changeAvatar(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </label>
              {session.user.avatarUpdatedAt ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void clearAvatar()}
                  disabled={avatarBusy}
                >
                  {t("contacts.removePhoto")}
                </Button>
              ) : null}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-zinc-400">
            {t("contacts.photoNote")}
          </p>
          {avatarMessage ? (
            <p className="mt-2 text-xs text-emerald-700">{avatarMessage}</p>
          ) : null}
          {avatarError ? (
            <div className="mt-2">
              <Alert variant="error">{avatarError}</Alert>
            </div>
          ) : null}
          <label className="mt-4 flex items-start gap-2 rounded-lg border border-zinc-200 p-3 text-xs text-zinc-600">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-current"
              checked={session.user.lastSeenVisible}
              disabled={lastSeenBusy}
              onChange={(event) => void toggleLastSeen(event.target.checked)}
            />
            <span>
              <span className="font-medium text-zinc-800">{t("contacts.lastSeenPublic")}</span>
              <br />
              {t("contacts.lastSeenNote")}
            </span>
          </label>
          {lastSeenError ? (
            <div className="mt-2">
              <Alert variant="error">{lastSeenError}</Alert>
            </div>
          ) : null}
          <form className="mt-4" onSubmit={(event) => void saveStatus(event)}>
            <Input
              value={statusDraft}
              maxLength={80}
              onChange={(event) => {
                setStatusDraft(event.target.value);
                setStatusMessage(null);
              }}
              placeholder={t("contacts.statusPlaceholder")}
              aria-label={t("contacts.statusAria")}
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-[11px] text-zinc-400">
                {t("contacts.statusNote", { count: statusDraft.length })}
              </p>
              <Button type="submit" size="sm" disabled={statusBusy}>
                {statusBusy ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <Check className="h-4 w-4" aria-hidden />
                )}
                {t("contacts.save")}
              </Button>
            </div>
          </form>
          {statusMessage ? (
            <p className="mt-2 text-xs text-emerald-700">{statusMessage}</p>
          ) : null}
          {statusError ? (
            <div className="mt-2">
              <Alert variant="error">{statusError}</Alert>
            </div>
          ) : null}
        </Card>

        <Card className="p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <Mail className="h-4 w-4 text-accent-600" aria-hidden />
            {t("contacts.inviteTitle")}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            {t("contacts.inviteNote")}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void navigator.clipboard.writeText(appLink)}
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden />
              {t("contacts.copyLink")}
            </Button>
            <a
              href={inviteMailto(appLink)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-700 hover:underline"
            >
              <Mail className="h-3.5 w-3.5" aria-hidden />
              {t("contacts.email")}
            </a>
            <span className="truncate text-[11px] text-zinc-400">{appLink}</span>
          </div>
        </Card>

        <section aria-label={t("contacts.listAria")}>
          <div className="mb-2 flex items-baseline justify-between px-1">
            <h2 className="text-sm font-semibold text-zinc-900">{t("contacts.people")}</h2>
            <span className="text-xs text-zinc-500">{t("contacts.count", { count: contacts.length })}</span>
          </div>

          {favoriteMutation.isError || blockMutation.isError || openMutation.isError ? (
            <div className="mb-2">
              <Alert variant="error">
                {t("contacts.updateFailed")}
              </Alert>
            </div>
          ) : null}

          {contactsQuery.isLoading ? (
            <div className="flex justify-center py-10">
              <Spinner className="h-5 w-5 text-accent-600" />
            </div>
          ) : contactsQuery.isError ? (
            <Alert variant="error">{t("contacts.loadFailed")}</Alert>
          ) : contacts.length === 0 ? (
            <Card className="px-4 py-10 text-center text-sm leading-relaxed text-zinc-500">
              {t("contacts.emptyTitle")}
              <br />
              {t("contacts.emptyHint")}
            </Card>
          ) : (
            <ul className="space-y-2">
              {contacts.map((contact) => {
                const blocked = contact.blockedByMe;
                return (
                  <li key={contact.id}>
                    <Card className="flex items-center gap-3 p-3">
                      <Avatar
                        name={contact.username}
                        userId={contact.id}
                        avatarUpdatedAt={contact.avatarUpdatedAt}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium text-zinc-900">
                          {contact.username}
                          {contact.favorite ? (
                            <Star
                              className="h-3.5 w-3.5 fill-amber-400 text-amber-500"
                              aria-label={t("contacts.favorite")}
                            />
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-zinc-500">
                          {contact.statusMessage ?? t("contacts.noStatus")}
                        </p>
                        {contact.blockedMe ? (
                          <p className="mt-0.5 text-[11px] text-amber-700">
                            {t("contacts.blockedByPeer")}
                          </p>
                        ) : null}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t(contact.favorite ? "contacts.unfavorite" : "contacts.favorite")}
                        title={t(contact.favorite ? "contacts.unfavorite" : "contacts.favorite")}
                        disabled={blocked || favoriteMutation.isPending}
                        onClick={() =>
                          favoriteMutation.mutate({
                            userId: contact.id,
                            favorite: !contact.favorite,
                          })
                        }
                      >
                        <Star
                          className={cn(
                            "h-4 w-4",
                            contact.favorite
                              ? "fill-amber-400 text-amber-500"
                              : "text-zinc-400",
                          )}
                          aria-hidden
                        />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t(blocked ? "contacts.unblock" : "contacts.block")}
                        title={t(blocked ? "contacts.unblock" : "contacts.block")}
                        disabled={blockMutation.isPending}
                        onClick={() => {
                          if (blocked) {
                            blockMutation.mutate({ userId: contact.id, blocked: false });
                          } else {
                            setBlockTarget(contact);
                          }
                        }}
                      >
                        {blocked ? (
                          <Check className="h-4 w-4 text-emerald-600" aria-hidden />
                        ) : (
                          <Ban className="h-4 w-4 text-zinc-400" aria-hidden />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("contacts.openChat", { name: contact.username ?? "" })}
                        title={t("contacts.openChatTitle")}
                        disabled={blocked || contact.blockedMe || openMutation.isPending}
                        onClick={() => openMutation.mutate(contact.id)}
                      >
                        <MessageSquare className="h-4 w-4 text-zinc-400" aria-hidden />
                      </Button>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <p className="px-1 text-center text-[11px] text-zinc-400">
          {t("contacts.blockNote")}
          <br />
          <Link className="underline hover:text-zinc-600" to="/">
            {t("contacts.backToList")}
          </Link>
        </p>
      </main>

      <Dialog
        open={blockTarget !== null}
        onClose={() => setBlockTarget(null)}
        title={t("contacts.blockDialogTitle")}
      >
        <p className="text-sm leading-relaxed text-zinc-600">
          {t("contacts.blockConfirm", { name: blockTarget ? `@${blockTarget.username}` : "" })}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setBlockTarget(null)}>
            {t("chat.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={blockMutation.isPending}
            onClick={() => {
              if (blockTarget) {
                blockMutation.mutate({ userId: blockTarget.id, blocked: true });
              }
            }}
          >
            <Ban className="h-4 w-4" aria-hidden />
            {t("contacts.blockAction")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

