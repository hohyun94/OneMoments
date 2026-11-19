import { Download, FileText, Pencil, Reply, ShieldAlert, Smile, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  DecryptionError,
  decryptAttachment,
  decryptMessage,
  parseAttachmentPayload,
  type AttachmentPayload,
  type StoredIdentity,
} from "../lib/crypto/index.ts";
import { formatBytes, formatClock } from "../lib/format.ts";
import { indexDecryptedMessage } from "../lib/search.ts";
import type { MessageView, ReactionSummary } from "../types.ts";
import { cn } from "./ui.tsx";

export async function decryptAttachmentBlob(
  attachment: AttachmentPayload,
  url = `/api/attachments/${attachment.id}`,
): Promise<Blob> {
  const response = await fetch(url, {
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "첨부 파일을 찾을 수 없습니다."
        : "첨부 파일을 내려받지 못했습니다.",
    );
  }
  const plaintext = await decryptAttachment(
    await response.arrayBuffer(),
    attachment.key,
    attachment.iv,
  );
  return new Blob([plaintext], {
    type: attachment.mime || "application/octet-stream",
  });
}

function AttachmentCard({
  attachment,
  own,
}: {
  attachment: AttachmentPayload;
  own: boolean;
}) {
  const isImage = attachment.mime.toLowerCase().startsWith("image/");
  const [downloading, setDownloading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(isImage);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setPreviewLoading(true);
    decryptAttachmentBlob(attachment)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "이미지를 열 수 없습니다.");
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.iv, attachment.key, attachment.mime, isImage]);

  async function download(): Promise<void> {
    setDownloading(true);
    setError(null);
    try {
      const blob = await decryptAttachmentBlob(attachment);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.name.replace(/[\\/:*?"<>|]/g, "_") || "attachment";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "첨부 파일을 열 수 없습니다.",
      );
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div
      className={cn(
        "rounded-xl border p-2.5",
        own ? "border-accent-400/40 bg-accent-500/20" : "border-zinc-200 bg-zinc-50",
      )}
    >
      {isImage ? (
        <div className="mb-2 overflow-hidden rounded-lg bg-black/5">
          {previewUrl ? (
            <button
              type="button"
              className="block w-full"
              onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")}
              aria-label={`${attachment.name} 크게 보기`}
            >
              <img
                src={previewUrl}
                alt={attachment.name}
                className="max-h-72 w-full object-contain"
                loading="lazy"
              />
            </button>
          ) : previewLoading ? (
            <div className="flex h-32 items-center justify-center text-xs text-zinc-500">
              이미지 복호화 중…
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            own ? "bg-accent-500/30 text-accent-contrast" : "bg-accent-100 text-accent-700",
          )}
        >
          <FileText className="h-4 w-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-sm font-medium",
              own ? "text-accent-contrast" : "text-zinc-900",
            )}
          >
            {attachment.name}
          </span>
          <span className={cn("text-[11px]", own ? "text-accent-contrast/80" : "text-zinc-500")}>
            {formatBytes(attachment.size)}
          </span>
        </span>
        <button
          type="button"
          onClick={() => void download()}
          disabled={downloading}
          aria-label="다운로드"
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors disabled:opacity-50",
            own
              ? "bg-white/20 text-accent-contrast hover:bg-white/30"
              : "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100",
          )}
        >
          {downloading ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <Download className="h-3.5 w-3.5" aria-hidden />
          )}
          다운로드
        </button>
      </div>
      {error ? (
        <p className={cn("mt-1.5 text-[11px]", own ? "text-accent-contrast/80" : "text-red-600")}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

type Result =
  | { status: "ok"; text: string; attachment: AttachmentPayload | null }
  | { status: "error"; detail: string };

const cache = new Map<string, Result>();
const inFlight = new Map<string, Promise<Result>>();
// 자동 삭제로 사라진 메시지는 진행 중이던 복호화가 끝나도 다시 캐시하지 않는다.
const autoDeletedMessageIds = new Set<string>();

/** 로그아웃/자동 잠금 시 복호화된 평문과 첨부 메타데이터를 메모리에서 제거한다. */
export function clearDecryptedMessageCache(): void {
  cache.clear();
  inFlight.clear();
  autoDeletedMessageIds.clear();
}

/** 자동 삭제 등으로 사라진 메시지의 복호화 캐시를 제거한다. */
export function deleteDecryptedMessageCache(messageId: string): void {
  autoDeletedMessageIds.add(messageId);
  const suffix = `:${messageId}`;
  for (const key of cache.keys()) {
    if (key.endsWith(suffix)) cache.delete(key);
  }
  for (const key of inFlight.keys()) {
    if (key.endsWith(suffix)) inFlight.delete(key);
  }
}

function failureDetail(error: unknown): string {
  if (error instanceof DecryptionError) {
    if (error.reason === "signature") return "서명 검증 실패 — 변조 가능성이 있습니다.";
    if (error.reason === "key") return "이 기기에서 읽을 수 없는 메시지입니다.";
    return "메시지를 복호화할 수 없습니다.";
  }
  return "메시지를 복호화할 수 없습니다.";
}

function decryptCached(identity: StoredIdentity, message: MessageView): Promise<Result> {
  const cacheKey = `${identity.deviceId ?? identity.identityPublicKey}:${message.id}`;
  const cached = cache.get(cacheKey);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const promise = decryptMessage({ identity, message })
    .then((decrypted): Result => {
      const attachment = parseAttachmentPayload(decrypted);
      return {
        status: "ok",
        text: attachment ? attachment.text : decrypted,
        attachment,
      };
    })
    .catch((error): Result => ({ status: "error", detail: failureDetail(error) }))
    .then((result) => {
      if (!autoDeletedMessageIds.has(message.id)) cache.set(cacheKey, result);
      return result;
    })
    .finally(() => {
      inFlight.delete(cacheKey);
    });

  inFlight.set(cacheKey, promise);
  return promise;
}

/** 반응/답장/수정 UI에서 다른 메시지의 평문이 필요할 때 사용한다. */
export async function decryptMessageText(
  identity: StoredIdentity,
  message: MessageView,
): Promise<string | null> {
  const result = await decryptCached(identity, message);
  return result.status === "ok" ? result.text : null;
}

function parseAttachment(text: string): AttachmentPayload | null {
  return parseAttachmentPayload(text);
}

export function MessageBubble({
  message,
  identity,
  own,
  senderName,
  readLabel,
  renderMessage,
  edited = false,
  replyTarget,
  replyTargetName,
  reactions = [],
  onReact,
  onReply,
  onEdit,
  onDelete,
}: {
  message: MessageView;
  identity: StoredIdentity;
  own: boolean;
  senderName: string;
  readLabel?: string | undefined;
  /** 수정된 본문을 복호화할 때 사용하는 이벤트 메시지 */
  renderMessage?: MessageView | null;
  edited?: boolean;
  replyTarget?: MessageView | null;
  replyTargetName?: string | undefined;
  reactions?: ReactionSummary[];
  onReact?: (message: MessageView, emoji: string) => void;
  onReply?: (message: MessageView, text: string) => void;
  onEdit?: (message: MessageView, text: string) => void;
  onDelete?: (message: MessageView) => void;
}) {
  const [result, setResult] = useState<Result | null>(() => cache.get(message.id) ?? null);
  const [reactionOpen, setReactionOpen] = useState(false);
  const [replyText, setReplyText] = useState<string | null>(null);
  const source = renderMessage ?? message;

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    void decryptCached(identity, source).then((value) => {
      if (!cancelled) setResult(value);
      if (value.status !== "ok" || message.kind !== "text") return;
      const searchable = [value.text, value.attachment?.name ?? ""]
        .filter((part) => part.length > 0)
        .join(" ");
      void indexDecryptedMessage({
        id: message.id,
        conversationId: message.conversationId,
        senderUserId: message.senderUserId,
        createdAt: message.createdAt,
        text: searchable,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [identity, message, source]);

  useEffect(() => {
    if (!replyTarget) {
      setReplyText(null);
      return;
    }
    let cancelled = false;
    void decryptCached(identity, replyTarget).then((value) => {
      if (!cancelled) setReplyText(value.status === "ok" ? value.text : null);
    });
    return () => {
      cancelled = true;
    };
  }, [identity, replyTarget]);

  const canAct = message.kind === "text";
  const canEdit = own && canAct && result?.status === "ok" && !result.attachment;
  const reactionPicker = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

  return (
    <div className={cn("group flex w-full flex-col", own ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm shadow-sm md:max-w-[70%]",
          own
            ? "rounded-br-md bg-accent-600 text-accent-contrast"
            : "rounded-bl-md border border-zinc-200 bg-white text-zinc-900",
        )}
      >
        {replyTarget !== undefined && replyTarget !== null ? (
          <div
            className={cn(
              "mb-1.5 rounded-lg border-l-2 px-2 py-1 text-[11px]",
              own
                ? "border-accent-contrast/60 bg-white/10 text-accent-contrast/90"
                : "border-accent-400 bg-zinc-50 text-zinc-600",
            )}
          >
            <p className="font-medium">{replyTargetName ?? "메시지"}</p>
            <p className="line-clamp-2 break-words">
              {replyText === null
                ? "원문을 불러오는 중…"
                : replyText || "첨부 메시지"}
            </p>
          </div>
        ) : null}

        {!own ? (
          <p className="mb-1 text-[11px] font-medium text-zinc-500">{senderName}</p>
        ) : null}

        {result?.status === "ok" ? (
          <div className="space-y-1.5">
            {result.text ? (
              <p className="whitespace-pre-wrap break-words leading-relaxed">
                {result.text}
              </p>
            ) : null}
            {result.attachment ? (
              <AttachmentCard attachment={result.attachment} own={own} />
            ) : null}
          </div>
        ) : result?.status === "error" ? (
          <p
            className={cn(
              "flex items-center gap-1.5 text-xs",
              own ? "text-accent-contrast/80" : "text-zinc-500",
            )}
          >
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
            {result.detail}
          </p>
        ) : (
          <p className={cn("text-xs", own ? "text-accent-contrast/80" : "text-zinc-400")}>
            복호화 중…
          </p>
        )}

        <p
          className={cn(
            "mt-1 text-right text-[10px]",
            own ? "text-accent-contrast/80" : "text-zinc-400",
          )}
        >
          {formatClock(message.createdAt)}
          {edited ? " · 수정됨" : ""}
          {own && readLabel ? ` · ${readLabel}` : ""}
        </p>
      </div>

      {reactions.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {reactions.map((reaction) => (
            <button
              key={reaction.emoji}
              type="button"
              onClick={() => onReact?.(message, reaction.emoji)}
              aria-pressed={reaction.mine}
              className={cn(
                "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                reaction.mine
                  ? "border-accent-400 bg-accent-50 text-accent-700"
                  : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50",
              )}
            >
              <span>{reaction.emoji}</span>
              <span>{reaction.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {canAct ? (
        <div className="mt-1 flex flex-wrap items-center gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          <button
            type="button"
            onClick={() => setReactionOpen((value) => !value)}
            aria-label="반응"
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <Smile className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (result?.status === "ok") onReply?.(message, result.text);
            }}
            aria-label="답장"
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            <Reply className="h-3.5 w-3.5" />
          </button>
          {canEdit ? (
            <button
              type="button"
              onClick={() => {
                if (result?.status === "ok") onEdit?.(message, result.text);
              }}
              aria-label="수정"
              className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {own ? (
            <button
              type="button"
              onClick={() => onDelete?.(message)}
              aria-label="삭제"
              className="rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {reactionOpen ? (
            <span className="flex items-center gap-0.5 rounded-full border border-zinc-200 bg-white px-1 py-0.5 shadow-sm">
              {reactionPicker.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`${emoji} 반응`}
                  onClick={() => {
                    setReactionOpen(false);
                    onReact?.(message, emoji);
                  }}
                  className="rounded-full px-1 text-sm hover:bg-zinc-100"
                >
                  {emoji}
                </button>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
