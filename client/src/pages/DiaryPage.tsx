import { BookOpen, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { RichTextEditor } from "../components/RichTextEditor.tsx";
import { Alert, Button, Card, Spinner, cn } from "../components/ui.tsx";
import { useI18n } from "../i18n.tsx";
import { api } from "../lib/api.ts";
import { decryptDiaryEntry, encryptDiaryEntry } from "../lib/diary.ts";
import {
  encodeDiaryPayload,
  loadDiaryPhoto,
  parseDiaryPayload,
  uploadDiaryPhoto,
  type DiaryPhotoRef,
} from "../lib/diaryPhotos.ts";
import { isDiaryHtmlEmpty, sanitizeDiaryHtml } from "../lib/richTextSanitize.ts";
import { useSession } from "../session.tsx";

type DiarySummary = { id: string; label: string | null; keyEpoch: number; ownerUsername: string };
type DiaryDevice = {
  id: string;
  identityPublicKey: string;
  signedPreKeyId: string | null;
  signedPreKeyPublicKey: string | null;
  signedPreKeySignature: string | null;
  oneTimePreKeyId: string | null;
  oneTimePreKeyPublicKey: string | null;
};
type DiaryMember = { userId: string; username: string; isOwner: boolean; devices: DiaryDevice[] };
type DiaryDetail = { id: string; label: string | null; keyEpoch: number; isOwner: boolean; members: DiaryMember[] };
type EntrySummary = { id: string; authorUsername: string; createdAt: string };
type EntryBody = {
  id: string;
  diaryId: string;
  authorSigningPublicKey: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  keys: Parameters<typeof decryptDiaryEntry>[1]["keys"];
};

function when(value: string, locale: string): string {
  return new Date(value).toLocaleString(locale === "en" ? "en-US" : "ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

/** 일기장 — 만료 없이 보관되고 지정한 대상에게만 공개. 글은 암호문으로만 저장한다. */
export function DiaryPage() {
  const { t, locale } = useI18n();
  const { identity } = useSession();
  const [diaries, setDiaries] = useState<DiarySummary[]>([]);
  const [detail, setDetail] = useState<DiaryDetail | null>(null);
  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [html, setHtml] = useState("");
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [openedHtml, setOpenedHtml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [audienceOpen, setAudienceOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [contacts, setContacts] = useState<Array<{ id: string; username: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newAudience, setNewAudience] = useState<Set<string>>(new Set());

  const openDiary = useCallback(
    async (diaryId: string) => {
      setBusy(true);
      setError(null);
      try {
        const [next, list] = await Promise.all([
          api<DiaryDetail>(`/api/diaries/${diaryId}`),
          api<{ entries: EntrySummary[] }>(`/api/diaries/${diaryId}/entries`),
        ]);
        setDetail(next);
        setEntries(list.entries);
        setOpenedId(null);
        setOpenedHtml(null);
      } catch {
        setError(t("diary.loadFailed"));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void api<{ diaries: DiarySummary[] }>("/api/diaries")
      .then((data) => {
        setDiaries(data.diaries);
        if (data.diaries[0]) void openDiary(data.diaries[0].id);
      })
      .catch(() => setError(t("diary.loadFailed")));
  }, [openDiary, t]);

  const devices = useMemo(
    () => (detail?.members ?? []).flatMap((member) => member.devices),
    [detail],
  );

  const [photos, setPhotos] = useState<DiaryPhotoRef[]>([]);
  const [openedPhotos, setOpenedPhotos] = useState<Array<{ id: string; url: string }>>([]);
  const [photoBusy, setPhotoBusy] = useState(false);
  /** 작성 중인 글의 멱등 키 — 사진 업로드와 글 저장이 같은 값을 쓴다. */
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());

  /** 사진 선택 → 즉시 암호화 업로드. 글 저장 시 같은 clientEntryId 로 연결된다. */
  async function addPhotos(files: FileList | null) {
    if (!files || files.length === 0 || !identity) return;
    setPhotoBusy(true);
    setError(null);
    try {
      const clientEntryId = crypto.randomUUID();
      const uploaded: DiaryPhotoRef[] = [];
      for (const file of Array.from(files).slice(0, 4)) {
        uploaded.push(await uploadDiaryPhoto({ file, clientEntryId }));
      }
      setPhotos((current) => [...current, ...uploaded]);
    } catch {
      setError(t("diary.photoFailed"));
    } finally {
      setPhotoBusy(false);
    }
  }

  async function saveEntry() {
    if (!identity || !detail) return;
    if (isDiaryHtmlEmpty(html)) {
      setError(t("diary.emptyBody"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const encrypted = await encryptDiaryEntry({
        identity,
        diaryId: detail.id,
        html: encodeDiaryPayload({ v: 1, html, photos }),
        devices,
        clientEntryId: draftId,
      });
      await api(`/api/diaries/${detail.id}/entries`, {
        method: "POST",
        body: {
          clientEntryId: encrypted.clientEntryId,
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce,
          signature: encrypted.signature,
          keys: encrypted.keys,
        },
      });
      setHtml("");
      setPhotos([]);
      setDraftId(crypto.randomUUID());
      await openDiary(detail.id);
    } catch {
      setError(t("diary.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  /** 소유자: 이름 변경. */
  async function renameCurrentDiary() {
    if (!detail) return;
    const next = window.prompt(t("diary.renamePrompt"), detail.label ?? "");
    if (next === null) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/diaries/${detail.id}`, { method: "PUT", body: { label: next.trim() } });
      const list = await api<{ diaries: DiarySummary[] }>("/api/diaries");
      setDiaries(list.diaries);
      await openDiary(detail.id);
    } catch {
      setError(t("diary.renameFailed"));
    } finally {
      setBusy(false);
    }
  }

  /** 소유자: 일기장 삭제(글·대상·첨부 행 cascade). */
  async function deleteCurrentDiary() {
    if (!detail) return;
    if (!window.confirm(t("diary.deleteConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/diaries/${detail.id}`, { method: "DELETE" });
      setDetail(null);
      setEntries([]);
      const list = await api<{ diaries: DiarySummary[] }>("/api/diaries");
      setDiaries(list.diaries);
      if (list.diaries[0]) await openDiary(list.diaries[0].id);
    } catch {
      setError(t("diary.deleteDiaryFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function openEntry(entryId: string) {
    if (!identity) return;
    setBusy(true);
    setError(null);
    try {
      const body = await api<EntryBody>(`/api/diaries/entries/${entryId}`);
      const plain = parseDiaryPayload(await decryptDiaryEntry(identity, body));
      setOpenedId(entryId);
      setOpenedHtml(plain.html);
      setOpenedPhotos([]);
      const loaded = await Promise.all(
        plain.photos.map(async (photo) => ({
          id: photo.id,
          url: await loadDiaryPhoto(photo).catch(() => ""),
        })),
      );
      setOpenedPhotos(loaded.filter((photo) => photo.url.length > 0));
    } catch {
      setError(t("diary.openFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function deleteEntry(entryId: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/diaries/entries/${entryId}`, { method: "DELETE" });
      if (detail) await openDiary(detail.id);
    } catch {
      setError(t("diary.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  /** 연락처 목록(대상 후보). 한 번만 불러온다. */
  async function loadContacts() {
    if (contacts.length > 0) return;
    try {
      const data = await api<{ contacts: Array<{ id: string; username: string }> }>(
        "/api/moments/contacts",
      );
      setContacts(data.contacts);
    } catch {
      setContacts([]);
    }
  }

  /** 새 일기장 만들기 — 이름과 초기 대상을 고른다(대상은 나중에 바꿀 수 있다). */
  async function createDiary() {
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ diaryId: string }>("/api/diaries", {
        method: "POST",
        body: { label: newLabel.trim() || undefined, audienceUserIds: [...newAudience] },
      });
      const list = await api<{ diaries: DiarySummary[] }>("/api/diaries");
      setDiaries(list.diaries);
      setCreating(false);
      setNewLabel("");
      setNewAudience(new Set());
      await openDiary(created.diaryId);
    } catch {
      setError(t("diary.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  /** 대상 관리 시트를 연다 — 현재 대상자를 선택 상태로 채우고 연락처를 로드한다. */
  async function openAudience() {
    if (!detail) return;
    setAudienceOpen(true);
    setNotice(null);
    setPicked(new Set(detail.members.filter((member) => !member.isOwner).map((m) => m.userId)));
    if (contacts.length === 0) {
      try {
        const data = await api<{ contacts: Array<{ id: string; username: string }> }>(
          "/api/moments/contacts",
        );
        setContacts(data.contacts);
      } catch {
        setContacts([]);
      }
    }
  }

  /** 대상 저장 — 서버가 키 세대를 올리고, 새 대상자는 이후 글만 볼 수 있다. */
  async function saveAudience() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ keyEpoch: number }>(`/api/diaries/${detail.id}/audience`, {
        method: "PUT",
        body: { audienceUserIds: [...picked] },
      });
      await openDiary(detail.id);
      setAudienceOpen(false);
      setNotice(t("diary.audienceSaved", { epoch: result.keyEpoch }));
    } catch {
      setError(t("diary.audienceFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
      <header className="flex items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold text-zinc-900">
          <BookOpen className="h-5 w-5 text-accent-600" aria-hidden />
          {t("diary.title")}
        </h1>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !detail}
          onClick={() => {
            if (detail) void openDiary(detail.id);
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden
          />
          {t("diary.refresh")}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setCreating((value) => !value);
            void loadContacts();
          }}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t("diary.new")}
        </Button>
      </header>

      {error ? <Alert variant="error">{error}</Alert> : null}
      {notice ? <Alert>{notice}</Alert> : null}

      {creating ? (
        <Card className="space-y-3 p-4">
          <div>
            <label className="block text-sm font-medium text-zinc-700" htmlFor="diary-new-label">
              {t("diary.labelLabel")}
            </label>
            <input
              id="diary-new-label"
              value={newLabel}
              maxLength={40}
              placeholder={t("diary.labelPlaceholder")}
              onChange={(event) => setNewLabel(event.target.value)}
              className="mt-1 h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-accent-400 focus:outline-none focus:ring-2 focus:ring-accent-100"
            />
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-700">
              {t("diary.audience", { count: newAudience.size })}
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {contacts.length === 0 ? (
                <p className="text-xs text-zinc-400">{t("diary.noContacts")}</p>
              ) : (
                contacts.map((contact) => {
                  const on = newAudience.has(contact.id);
                  return (
                    <button
                      key={contact.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setNewAudience((current) => {
                          const next = new Set(current);
                          if (next.has(contact.id)) next.delete(contact.id);
                          else next.add(contact.id);
                          return next;
                        })
                      }
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs",
                        on
                          ? "border-accent-300 bg-accent-50 text-accent-700"
                          : "border-zinc-200 text-zinc-600 hover:bg-zinc-50",
                      )}
                    >
                      @{contact.username}
                    </button>
                  );
                })
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setCreating(false)}>
              {t("chat.cancel")}
            </Button>
            <Button size="sm" onClick={() => void createDiary()} disabled={busy}>
              {busy ? <Spinner /> : null}
              {t("diary.create")}
            </Button>
          </div>
        </Card>
      ) : null}

      {diaries.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {diaries.map((diary) => (
            <button
              key={diary.id}
              type="button"
              onClick={() => void openDiary(diary.id)}
              aria-pressed={detail?.id === diary.id}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs",
                detail?.id === diary.id
                  ? "border-accent-300 bg-accent-50 text-accent-700"
                  : "border-zinc-200 text-zinc-600 hover:bg-zinc-50",
              )}
            >
              {diary.label ?? t("diary.untitled")}
            </button>
          ))}
        </div>
      ) : null}

      {detail ? (
        <>
          <Card className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-zinc-900">
                {detail.label ?? t("diary.untitled")}
              </h2>
              <span className="text-xs text-zinc-500">
                {t("diary.members", { count: detail.members.length })} ·{" "}
                {t("diary.epoch", { epoch: detail.keyEpoch })}
              </span>
            </div>
            <p className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-zinc-500">
              {detail.members.map((member) => (
                <span key={member.userId} className="rounded-full bg-zinc-100 px-2 py-0.5">
                  @{member.username}
                  {member.isOwner ? ` · ${t("diary.owner")}` : ""}
                </span>
              ))}
            </p>
            {detail.isOwner ? (
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => void openAudience()}>
                  {t("diary.manageAudience")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void renameCurrentDiary()}>
                  {t("diary.rename")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void deleteCurrentDiary()}>
                  {t("diary.deleteDiary")}
                </Button>
              </div>
            ) : null}
            {audienceOpen ? (
              <div className="mt-3 rounded-lg border border-zinc-200 p-3">
                <p className="text-xs leading-relaxed text-zinc-500">{t("diary.audienceNote")}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {contacts.length === 0 ? (
                    <p className="text-xs text-zinc-400">{t("diary.noContacts")}</p>
                  ) : (
                    contacts.map((contact) => {
                      const on = picked.has(contact.id);
                      return (
                        <button
                          key={contact.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() =>
                            setPicked((current) => {
                              const next = new Set(current);
                              if (next.has(contact.id)) next.delete(contact.id);
                              else next.add(contact.id);
                              return next;
                            })
                          }
                          className={cn(
                            "rounded-full border px-2.5 py-1 text-xs",
                            on
                              ? "border-accent-300 bg-accent-50 text-accent-700"
                              : "border-zinc-200 text-zinc-600 hover:bg-zinc-50",
                          )}
                        >
                          @{contact.username}
                        </button>
                      );
                    })
                  )}
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setAudienceOpen(false)}>
                    {t("chat.cancel")}
                  </Button>
                  <Button size="sm" onClick={() => void saveAudience()} disabled={busy}>
                    {busy ? <Spinner /> : null}
                    {t("diary.saveAudience")}
                  </Button>
                </div>
              </div>
            ) : null}
          </Card>

          <Card className="space-y-2 p-4">
            <p className="text-sm font-medium text-zinc-900">{t("diary.write")}</p>
            <RichTextEditor value={html} onChange={setHtml} />
            <div className="flex flex-wrap items-center gap-2">
              <label
                className="cursor-pointer rounded-lg border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
                aria-label={t("diary.photoAdd")}
              >
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  onChange={(event) => {
                    void addPhotos(event.target.files);
                    event.target.value = "";
                  }}
                />
                {photoBusy ? t("admin.loading") : t("diary.photoAdd")}
              </label>
              {photos.map((photo) => (
                <span
                  key={photo.id}
                  className="flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600"
                >
                  {t("diary.photo")}
                  <button
                    type="button"
                    aria-label={t("diary.photoRemove")}
                    onClick={() => setPhotos((current) => current.filter((item) => item.id !== photo.id))}
                    className="text-zinc-400 hover:text-red-600"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex justify-end">
              <Button onClick={() => void saveEntry()} disabled={busy}>
                {busy ? <Spinner /> : null}
                {t("diary.save")}
              </Button>
            </div>
          </Card>

          <Card className="overflow-hidden">
            {entries.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-500">{t("diary.noEntries")}</p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {entries.map((entry) => (
                  <li key={entry.id} className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void openEntry(entry.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="block truncate text-sm text-zinc-900">
                          @{entry.authorUsername}
                        </span>
                        <span className="mt-0.5 block text-xs text-zinc-500">
                          {when(entry.createdAt, locale)}
                        </span>
                      </button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("diary.delete")}
                        onClick={() => void deleteEntry(entry.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </div>
                    {openedId === entry.id && openedHtml !== null ? (
                      <div
                        className="mt-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm leading-relaxed text-zinc-800 [&_a]:text-accent-700 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-300 [&_blockquote]:pl-3 [&_h2]:text-base [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ol_li]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-white [&_pre]:px-2 [&_pre]:py-1.5 [&_pre]:font-mono [&_pre]:text-xs"
                        aria-label={t("diary.entryBody")}
                        dangerouslySetInnerHTML={{ __html: sanitizeDiaryHtml(openedHtml) }}
                      />
                    ) : null}
                    {openedId === entry.id && openedPhotos.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {openedPhotos.map((photo) => (
                          <img
                            key={photo.id}
                            src={photo.url}
                            alt={t("diary.photo")}
                            role="button"
                            tabIndex={0}
                            onClick={() => window.open(photo.url, "_blank", "noopener,noreferrer")}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                window.open(photo.url, "_blank", "noopener,noreferrer");
                              }
                            }}
                            className="h-24 w-24 cursor-pointer rounded-lg border border-zinc-200 object-cover"
                          />
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : (
        <Card className="p-6 text-center text-sm text-zinc-500">
          {busy ? <Spinner /> : t("diary.empty")}
        </Card>
      )}
    </div>
  );
}
