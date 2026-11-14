import { Download, FileText, ShieldAlert } from "lucide-react";
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
import type { MessageView } from "../types.ts";
import { cn } from "./ui.tsx";

function AttachmentCard({
  attachment,
  own,
}: {
  attachment: AttachmentPayload;
  own: boolean;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download(): Promise<void> {
    setDownloading(true);
    setError(null);
    try {
      const response = await fetch(`/api/attachments/${attachment.id}`, {
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
      const blob = new Blob([plaintext], {
        type: attachment.mime || "application/octet-stream",
      });
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
        own ? "border-violet-400/40 bg-violet-500/20" : "border-zinc-200 bg-zinc-50",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            own ? "bg-violet-500/30 text-white" : "bg-violet-100 text-violet-700",
          )}
        >
          <FileText className="h-4 w-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-sm font-medium",
              own ? "text-white" : "text-zinc-900",
            )}
          >
            {attachment.name}
          </span>
          <span className={cn("text-[11px]", own ? "text-violet-100" : "text-zinc-500")}>
            {formatBytes(attachment.size)} · 종단간 암호화
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
              ? "bg-white/20 text-white hover:bg-white/30"
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
        <p className={cn("mt-1.5 text-[11px]", own ? "text-violet-100" : "text-red-600")}>
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
      cache.set(cacheKey, result);
      return result;
    })
    .finally(() => {
      inFlight.delete(cacheKey);
    });

  inFlight.set(cacheKey, promise);
  return promise;
}

function parseAttachment(text: string): AttachmentPayload | null {
  return parseAttachmentPayload(text);
}

export function MessageBubble({
  message,
  identity,
  own,
  senderName,
}: {
  message: MessageView;
  identity: StoredIdentity;
  own: boolean;
  senderName: string;
}) {
  const [result, setResult] = useState<Result | null>(() => cache.get(message.id) ?? null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    void decryptCached(identity, message).then((value) => {
      if (!cancelled) setResult(value);
    });
    return () => {
      cancelled = true;
    };
  }, [identity, message]);

  return (
    <div className={cn("flex w-full", own ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm shadow-sm md:max-w-[70%]",
          own
            ? "rounded-br-md bg-violet-600 text-white"
            : "rounded-bl-md border border-zinc-200 bg-white text-zinc-900",
        )}
      >
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
              own ? "text-violet-100" : "text-zinc-500",
            )}
          >
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
            {result.detail}
          </p>
        ) : (
          <p className={cn("text-xs", own ? "text-violet-200" : "text-zinc-400")}>
            복호화 중…
          </p>
        )}

        <p
          className={cn(
            "mt-1 text-right text-[10px]",
            own ? "text-violet-200" : "text-zinc-400",
          )}
        >
          {formatClock(message.createdAt)}
        </p>
      </div>
    </div>
  );
}
