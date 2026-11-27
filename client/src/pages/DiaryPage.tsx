import { BookOpen, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { RichTextEditor } from "../components/RichTextEditor.tsx";
import { Alert, Button, Card, Spinner, cn } from "../components/ui.tsx";
import { useI18n } from "../i18n.tsx";
import { api } from "../lib/api.ts";
import { decryptDiaryEntry, encryptDiaryEntry } from "../lib/diary.ts";
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
type DiaryDetail = { id: string; label: string | null; keyEpoch: number; members: DiaryMember[] };
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

  async function saveEntry() {
    if (!identity || !detail) return;
    if (isDiaryHtmlEmpty(html)) {
      setError(t("diary.emptyBody"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const encrypted = await encryptDiaryEntry({ identity, diaryId: detail.id, html, devices });
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
      await openDiary(detail.id);
    } catch {
      setError(t("diary.saveFailed"));
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
      setOpenedId(entryId);
      setOpenedHtml(await decryptDiaryEntry(identity, body));
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
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {t("diary.refresh")}
        </Button>
      </header>

      {error ? <Alert variant="error">{error}</Alert> : null}

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
          </Card>

          <Card className="space-y-2 p-4">
            <p className="text-sm font-medium text-zinc-900">{t("diary.write")}</p>
            <RichTextEditor value={html} onChange={setHtml} />
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
