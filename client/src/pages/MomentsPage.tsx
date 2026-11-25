import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ImagePlus, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import {
  Alert,
  Avatar,
  Button,
  Dialog,
  Label,
  Spinner,
  Textarea,
} from "../components/ui.tsx";
import { decryptAttachmentBlob } from "../components/MessageBubble.tsx";
import { ApiError, api } from "../lib/api.ts";
import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  encodeAttachmentPayload,
  encryptAttachment,
  type AttachmentPayload,
} from "../lib/crypto/index.ts";
import {
  decryptMoment,
  encryptMoment,
  isMomentAuthor,
  momentTimeLeft,
  parseMomentContent,
} from "../lib/moments.ts";
import { useI18n } from "../i18n.tsx";
import { useSession } from "../session.tsx";
import type { MomentContact, MomentDevice, MomentView } from "../types.ts";

interface ContactsResponse {
  contacts: MomentContact[];
  selfDevices: MomentDevice[];
}

interface MomentContent {
  text: string;
  attachment: AttachmentPayload | null;
}

function MomentImage({ attachment }: { attachment: AttachmentPayload }) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    void decryptAttachmentBlob(
      attachment,
      `/api/moments/attachments/${attachment.id}`,
    )
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment]);

  if (failed) {
    return (
      <p className="rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-500">
        {t("moments.imageLoadFailed")}
      </p>
    );
  }
  if (!url) {
    return (
      <p className="rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-400">
        {t("moments.imageLoading")}
      </p>
    );
  }
  return (
    <img
      src={url}
      alt=""
      className="max-h-64 w-full rounded-lg object-cover"
      loading="lazy"
    />
  );
}

function MomentCard({
  moment,
  identity,
  currentUserId,
  onOpen,
}: {
  moment: MomentView;
  identity: NonNullable<ReturnType<typeof useSession>["identity"]>;
  currentUserId: string;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const [content, setContent] = useState<MomentContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const author = moment.author.username ?? t("moments.deletedAuthor");

  useEffect(() => {
    let active = true;
    setContent(null);
    setError(null);
    void decryptMoment(identity, moment)
      .then((plaintext) => {
        if (!active) return;
        setContent(parseMomentContent(plaintext));
      })
      .catch(() => {
        if (active) setError(t("moments.unreadable"));
      });
    return () => {
      active = false;
    };
  }, [identity, moment]);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col rounded-2xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition-colors hover:bg-zinc-50"
    >
      <span className="flex items-center gap-2">
        <Avatar name={author} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-zinc-900">
            @{author}
          </span>
          <span className="block text-[11px] text-zinc-500">
            {momentTimeLeft(moment.expiresAt)}
          </span>
        </span>
        {moment.author.id === currentUserId ? (
          <span className="text-[11px] text-zinc-500">
            {t("moments.viewCount", { count: moment.viewCount ?? 0 })}
          </span>
        ) : moment.viewed ? (
          <span className="text-[11px] text-zinc-400">{t("moments.viewed")}</span>
        ) : null}
      </span>

      {error ? (
        <span className="mt-3 text-xs text-zinc-500">{error}</span>
      ) : content ? (
        <span className="mt-3 flex flex-col gap-2">
          {content.attachment ? <MomentImage attachment={content.attachment} /> : null}
          {content.text ? (
            <span className="line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800">
              {content.text}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="mt-3 text-xs text-zinc-400">{t("moments.decrypting")}</span>
      )}
    </button>
  );
}

function MomentViewer({
  moment,
  identity,
  currentUserId,
  onClose,
  onDelete,
}: {
  moment: MomentView;
  identity: NonNullable<ReturnType<typeof useSession>["identity"]>;
  currentUserId: string;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [content, setContent] = useState<MomentContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const author = moment.author.username ?? t("moments.deletedAuthor");
  const isAuthor = isMomentAuthor(moment, currentUserId);

  useEffect(() => {
    let active = true;
    setContent(null);
    setError(null);
    void decryptMoment(identity, moment)
      .then((plaintext) => {
        if (active) setContent(parseMomentContent(plaintext));
      })
      .catch(() => {
        if (active) setError(t("moments.unreadable"));
      });
    return () => {
      active = false;
    };
  }, [identity, moment]);

  useEffect(() => {
    if (isAuthor) return;
    void api(`/api/moments/${moment.id}/view`, { method: "POST" }).catch(
      () => undefined,
    );
  }, [isAuthor, moment.id]);

  const viewsQuery = useQuery({
    queryKey: ["moment-views", moment.id],
    queryFn: () =>
      api<{ views: Array<{ userId: string; username: string; viewedAt: string }> }>(
        `/api/moments/${moment.id}/views`,
      ).then((response) => response.views),
    enabled: isAuthor,
  });

  return (
    <Dialog open onClose={onClose} title={t("moments.dialogTitle")}>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Avatar name={author} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-zinc-900">@{author}</p>
            <p className="text-[11px] text-zinc-500">
              {momentTimeLeft(moment.expiresAt)}
            </p>
          </div>
          {isAuthor ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600"
              onClick={onDelete}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              {t("moments.delete")}
            </Button>
          ) : null}
        </div>

        {error ? (
          <Alert variant="error">{error}</Alert>
        ) : content ? (
          <div className="space-y-3">
            {content.attachment ? <MomentImage attachment={content.attachment} /> : null}
            {content.text ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800">
                {content.text}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-zinc-400">{t("moments.decrypting")}</p>
        )}

        {isAuthor ? (
          <div className="border-t border-zinc-100 pt-3">
            <p className="text-xs font-medium text-zinc-600">
              {t("moments.viewersCount", { count: viewsQuery.data?.length ?? 0 })}
            </p>
            <div className="mt-2 max-h-32 space-y-1 overflow-y-auto">
              {(viewsQuery.data ?? []).map((view) => (
                <p key={view.userId} className="text-xs text-zinc-500">
                  @{view.username} · {new Date(view.viewedAt).toLocaleString()}
                </p>
              ))}
              {viewsQuery.isLoading ? (
                <p className="text-xs text-zinc-400">{t("moments.viewersLoading")}</p>
              ) : null}
              {!viewsQuery.isLoading && (viewsQuery.data ?? []).length === 0 ? (
                <p className="text-xs text-zinc-400">{t("moments.viewersEmpty")}</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function MomentComposer({
  open,
  onClose,
  identity,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  identity: NonNullable<ReturnType<typeof useSession>["identity"]>;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setText("");
    setFile(null);
    setBusy(false);
    setError(null);
  }, [open]);

  const contactsQuery = useQuery({
    queryKey: ["moment-contacts"],
    queryFn: () => api<ContactsResponse>("/api/moments/contacts"),
    enabled: open,
  });

  function toggleContact(userId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function selectFile(event: ChangeEvent<HTMLInputElement>): void {
    const selectedFile = event.target.files?.[0] ?? null;
    setError(null);
    if (!selectedFile) {
      setFile(null);
      return;
    }
    if (!selectedFile.type.startsWith("image/")) {
      setFile(null);
      setError(t("moments.imageOnly"));
      event.target.value = "";
      return;
    }
    if (selectedFile.size > MAX_ATTACHMENT_BYTES) {
      setFile(null);
      setError(t("moments.imageTooBig"));
      event.target.value = "";
      return;
    }
    setFile(selectedFile);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (selected.size === 0) {
      setError(t("moments.pickAudience"));
      return;
    }
    if (!text.trim() && !file) {
      setError(t("moments.needContent"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const contacts = contactsQuery.data;
      if (!contacts) throw new Error(t("moments.contactsFailed"));
      const audienceUserIds = [...selected];
      const devices = [
        ...contacts.selfDevices,
        ...contacts.contacts
          .filter((contact) => selected.has(contact.id))
          .flatMap((contact) => contact.devices),
      ];
      const uniqueDevices = [
        ...new Map(devices.map((device) => [device.id, device])).values(),
      ];
      if (uniqueDevices.length === 0) {
        throw new Error(t("moments.peerDevicesMissing"));
      }

      const momentId = crypto.randomUUID();
      let attachmentId: string | undefined;
      let attachmentMeta:
        | { id: string; name: string; mime: string; size: number; key: string; iv: string }
        | undefined;
      if (file) {
        const encrypted = await encryptAttachment(file);
        const uploaded = await api<{ attachment: { id: string; size: number } }>(
          "/api/moments/attachments",
          {
            method: "POST",
            rawBody: new Blob([encrypted.ciphertext], {
              type: "application/octet-stream",
            }),
            headers: { "x-moment-id": momentId },
          },
        );
        attachmentId = uploaded.attachment.id;
        attachmentMeta = {
          id: uploaded.attachment.id,
          name: file.name,
          mime: file.type || "application/octet-stream",
          size: file.size,
          key: encrypted.key,
          iv: encrypted.iv,
        };
      }

      const plaintext = attachmentMeta
        ? encodeAttachmentPayload({ ...attachmentMeta, text: text.trim() })
        : text.trim();
      const payload = await encryptMoment({
        identity,
        id: momentId,
        plaintext,
        devices: uniqueDevices,
        audienceUserIds,
        attachmentId,
      });
      await api<{ moment: MomentView }>("/api/moments", {
        method: "POST",
        body: payload,
      });
      onCreated();
      onClose();
    } catch (caught) {
      if (caught instanceof AttachmentError) setError(caught.message);
      else if (caught instanceof ApiError) setError(caught.message);
      else setError(caught instanceof Error ? caught.message : t("moments.shareFailed"));
    } finally {
      setBusy(false);
    }
  }

  const contacts = contactsQuery.data?.contacts ?? [];

  return (
    <Dialog open={open} onClose={onClose} title={t("moments.shareDialogTitle")}>
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <p className="text-xs leading-relaxed text-zinc-500">
          {t("moments.shareNote")}
        </p>

        <div>
          <Label>{t("moments.audience", { count: selected.size })}</Label>
          <div className="mt-1.5 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-zinc-200 p-2">
            {contactsQuery.isLoading ? (
              <p className="px-1 py-2 text-xs text-zinc-400">{t("moments.viewersLoading")}</p>
            ) : contacts.length === 0 ? (
              <p className="px-1 py-2 text-xs text-zinc-500">
                {t("moments.noContacts")}
              </p>
            ) : (
              contacts.map((contact) => (
                <label
                  key={contact.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm text-zinc-700 hover:bg-zinc-50"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-zinc-300 text-accent-600 focus:ring-accent-400"
                    checked={selected.has(contact.id)}
                    disabled={busy || contact.devices.length === 0}
                    onChange={() => toggleContact(contact.id)}
                  />
                  <span className="min-w-0 flex-1 truncate">@{contact.username}</span>
                  {contact.devices.length === 0 ? (
                    <span className="text-[11px] text-zinc-400">{t("moments.noActiveDevices")}</span>
                  ) : null}
                </label>
              ))
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="moment-text">{t("moments.content")}</Label>
          <Textarea
            id="moment-text"
            rows={3}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("moments.contentPlaceholder")}
          />
        </div>

        <div>
          <input
            type="file"
            accept="image/*"
            className="hidden"
            id="moment-image"
            onChange={selectFile}
            disabled={busy}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => document.getElementById("moment-image")?.click()}
            >
              <ImagePlus className="h-4 w-4" aria-hidden />
              {t("moments.image")}
            </Button>
            {file ? (
              <span className="flex items-center gap-2 text-xs text-zinc-600">
                {file.name}
                <button
                  type="button"
                  aria-label={t("moments.removeImage")}
                  onClick={() => {
                    setFile(null);
                    const input = document.getElementById(
                      "moment-image",
                    ) as HTMLInputElement | null;
                    if (input) input.value = "";
                  }}
                  className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ) : null}
          </div>
        </div>

        {error ? <Alert variant="error">{error}</Alert> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t("chat.cancel")}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner /> : <Sparkles className="h-4 w-4" aria-hidden />}
            {t("moments.share")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function MomentsPage() {
  const { t } = useI18n();
  const { session, identity } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [composerOpen, setComposerOpen] = useState(false);
  const [viewer, setViewer] = useState<MomentView | null>(null);

  const feedQuery = useQuery({
    queryKey: ["moments"],
    queryFn: () =>
      api<{ moments: MomentView[] }>("/api/moments/feed").then(
        (response) => response.moments,
      ),
    enabled: Boolean(identity),
    refetchInterval: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (momentId: string) =>
      api(`/api/moments/${momentId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["moments"] });
      setViewer(null);
    },
  });

  if (!session || !identity) return null;

  const moments = feedQuery.data ?? [];

  return (
    <div className="min-h-dvh bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white px-4 py-3">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/")}
            aria-label={t("moments.back")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
              <Sparkles className="h-4 w-4 text-accent-600" aria-hidden />
              Moments
            </h1>
            <p className="text-[11px] text-zinc-500">
              {t("moments.subtitle")}
            </p>
          </div>
          <Button onClick={() => setComposerOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("moments.shareButton")}
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-5">
        {feedQuery.isLoading ? (
          <p className="py-16 text-center text-sm text-zinc-500">{t("moments.viewersLoading")}</p>
        ) : feedQuery.isError ? (
          <Alert variant="error">{t("moments.loadFailed")}</Alert>
        ) : moments.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-50 text-accent-600">
              <Sparkles className="h-7 w-7" aria-hidden />
            </span>
            <p className="text-sm text-zinc-500">
              {t("moments.emptyTitle")}
              <br />
              {t("moments.emptyHint")}
            </p>
            <Button onClick={() => setComposerOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t("moments.shareButton")}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {moments.map((moment) => (
              <MomentCard
                key={moment.id}
                moment={moment}
                identity={identity}
                currentUserId={session.user.id}
                onOpen={() => setViewer(moment)}
              />
            ))}
          </div>
        )}
      </main>

      {composerOpen ? (
        <MomentComposer
          open
          onClose={() => setComposerOpen(false)}
          identity={identity}
          onCreated={() => {
            void queryClient.invalidateQueries({ queryKey: ["moments"] });
            void queryClient.invalidateQueries({ queryKey: ["moment-contacts"] });
          }}
        />
      ) : null}

      {viewer ? (
        <MomentViewer
          moment={viewer}
          identity={identity}
          currentUserId={session.user.id}
          onClose={() => setViewer(null)}
          onDelete={() => deleteMutation.mutate(viewer.id)}
        />
      ) : null}
    </div>
  );
}
