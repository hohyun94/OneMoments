import { FileText, ImageOff, Mic } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AttachmentPayload, StoredIdentity } from "../lib/crypto/index.ts";
import { formatBytes } from "../lib/format.ts";
import { formatDuration } from "../lib/voice.ts";
import type { MessageView } from "../types.ts";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { decryptAttachmentBlob, decryptAttachmentPayload } from "./MessageBubble.tsx";
import { useI18n } from "../i18n.tsx";
import { Button, Dialog, Spinner } from "./ui.tsx";

/** 한 번에 복호화해 보여줄 첨부 수(메모리·CPU 보호). */
const MAX_GALLERY_ITEMS = 60;

interface GalleryItem {
  messageId: string;
  attachment: AttachmentPayload;
}

function GalleryImage({ item }: { item: GalleryItem }) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    decryptAttachmentBlob(item.attachment)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.attachment.id, item.attachment.iv, item.attachment.key]);

  if (!url) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-lg bg-zinc-100 text-zinc-400">
        <ImageOff className="h-4 w-4" aria-hidden />
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("msg.openLarger", { name: item.attachment.name })}
        className="aspect-square overflow-hidden rounded-lg bg-zinc-100"
      >
        <img src={url} alt={item.attachment.name} className="h-full w-full object-cover" />
      </button>
      {open ? (
        <ImageLightbox
          src={url}
          name={item.attachment.name}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * 대화의 첨부(사진·파일·음성)를 모아 보여준다.
 *
 * 서버는 암호문만 보관하므로, **이 기기에서 복호화 가능한 메시지**를 대상으로 한다
 * (현재 불러온 이력 범위 — "이전 메시지"를 더 불러오면 범위가 넓어진다).
 */
export function MediaGalleryDialog({
  open,
  onClose,
  messages,
  identity,
  onJump,
}: {
  open: boolean;
  onClose: () => void;
  messages: MessageView[];
  identity: StoredIdentity;
  onJump: (messageId: string) => void;
}) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const { t } = useI18n();
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  /** 메시지 배열은 렌더마다 새 객체이므로, 내용 기준 시그니처로만 다시 계산한다. */
  const signature = messages.map((message) => message.id).join(",");

  useEffect(() => {
    if (!open) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const candidates = [...messagesRef.current]
      .reverse()
      .filter((message) => message.kind === "text")
      .slice(0, MAX_GALLERY_ITEMS);
    void Promise.all(
      candidates.map(async (message) => {
        const attachment = await decryptAttachmentPayload(identity, message).catch(() => null);
        return attachment ? { messageId: message.id, attachment } : null;
      }),
    ).then((results) => {
      if (cancelled) return;
      setItems(results.filter((item): item is GalleryItem => item !== null));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, signature, identity]);

  const images = items.filter((item) => item.attachment.mime.startsWith("image/"));
  const voices = items.filter((item) => item.attachment.mime.startsWith("audio/"));
  const files = items.filter(
    (item) =>
      !item.attachment.mime.startsWith("image/") && !item.attachment.mime.startsWith("audio/"),
  );

  return (
    <Dialog open={open} onClose={onClose} title={t("media.title")}>
      <div className="space-y-4" data-testid="media-gallery">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner /> {t("media.loading")}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("media.empty")}</p>
        ) : (
          <>
            {images.length > 0 ? (
              <section aria-label={t("media.imagesAria")}>
                <h3 className="mb-2 text-xs font-semibold text-zinc-700">
                  {t("media.images")} <span className="text-zinc-400">{images.length}</span>
                </h3>
                <div className="grid grid-cols-3 gap-1.5">
                  {images.map((item) => (
                    <GalleryImage key={item.attachment.id} item={item} />
                  ))}
                </div>
              </section>
            ) : null}
            {voices.length + files.length > 0 ? (
              <section aria-label={t("media.filesAria")}>
                <h3 className="mb-2 text-xs font-semibold text-zinc-700">
                  {t("media.files")} <span className="text-zinc-400">{voices.length + files.length}</span>
                </h3>
                <ul className="space-y-1">
                  {[...voices, ...files].map((item) => {
                    const isVoice = item.attachment.mime.startsWith("audio/");
                    return (
                      <li key={item.attachment.id}>
                        <button
                          type="button"
                          onClick={() => {
                            onJump(item.messageId);
                            onClose();
                          }}
                          className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 px-2 py-1.5 text-left text-xs hover:bg-zinc-50"
                        >
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-100 text-accent-700">
                            {isVoice ? (
                              <Mic className="h-3.5 w-3.5" aria-hidden />
                            ) : (
                              <FileText className="h-3.5 w-3.5" aria-hidden />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-zinc-800">
                              {item.attachment.name}
                            </span>
                            <span className="text-zinc-400">
                              {item.attachment.durationSeconds !== undefined
                                ? `${formatDuration(item.attachment.durationSeconds)} · `
                                : ""}
                              {formatBytes(item.attachment.size)}
                            </span>
                          </span>
                          <span className="shrink-0 text-accent-700">{t("media.toMessage")}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
            <p className="text-[11px] leading-relaxed text-zinc-400">
              {t("media.note", { count: MAX_GALLERY_ITEMS })}
            </p>
          </>
        )}
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("media.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
