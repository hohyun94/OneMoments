import { Download, EyeOff, FileText, Pause, Pencil, Pin, Play, Reply, ShieldAlert, Smile, Trash2 } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type MouseEvent } from "react";

import {
  DecryptionError,
  decryptAttachment,
  decryptMessage,
  parseAttachmentPayload,
  type AttachmentPayload,
  type StoredIdentity,
} from "../lib/crypto/index.ts";
import { formatBytes, formatClock } from "../lib/format.ts";
import { parseLocationPayload, type LocationPayload } from "../lib/location.ts";
import { parseLinkMessage, previewHost, type LinkMessagePayload } from "../lib/linkPreviewMessage.ts";
import { mentionsUser } from "../lib/mentions.ts";
import { tokenizeMessage } from "../lib/richText.ts";
import { formatDuration } from "../lib/voice.ts";
import { indexDecryptedMessage } from "../lib/search.ts";
import { viewOnceHint } from "../lib/viewOnce.ts";
import type { MessageView, ReactionSummary } from "../types.ts";
import { LocationCard } from "./LocationCard.tsx";
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

/** 아이콘만 있는 다운로드 버튼(툴팁·스크린리더 이름은 "다운로드"). */
function DownloadIconButton({
  own,
  downloading,
  onClick,
}: {
  own: boolean;
  downloading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={downloading}
      aria-label="다운로드"
      title="다운로드"
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50",
        own
          ? "bg-white/20 text-accent-contrast hover:bg-white/30"
          : "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100",
      )}
    >
      {downloading ? (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        <Download className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
}

function AttachmentCard({
  attachment,
  own,
}: {
  attachment: AttachmentPayload;
  own: boolean;
}) {
  const isImage = attachment.mime.toLowerCase().startsWith("image/");
  const isAudio = attachment.mime.toLowerCase().startsWith("audio/");
  const needsPreview = isImage || isAudio;
  const [downloading, setDownloading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(needsPreview);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadedDuration, setLoadedDuration] = useState<number | null>(null);
  // WebM 은 메타데이터에 길이가 없어 duration 이 Infinity 인 브라우저가 있다.
  // 그때는 송신자가 암호문에 담아 보낸 길이로 진행 표시·이동을 계산한다.
  const totalSeconds =
    loadedDuration ?? (attachment.durationSeconds ? attachment.durationSeconds : 0);
  const progress = totalSeconds > 0 ? Math.min(1, elapsed / totalSeconds) : 0;

  function syncDuration(): void {
    const audio = audioRef.current;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      setLoadedDuration(audio.duration);
    }
  }

  function handleTimeUpdate(): void {
    const audio = audioRef.current;
    if (!audio) return;
    syncDuration();
    setElapsed(audio.currentTime);
  }

  async function togglePlay(): Promise<void> {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        // 자동재생 정책 등으로 막히면 버튼 상태만 되돌린다.
        setPlaying(false);
      }
    } else {
      audio.pause();
    }
  }

  function seekFromWaveform(event: MouseEvent<HTMLButtonElement>): void {
    const audio = audioRef.current;
    if (!audio || totalSeconds <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * totalSeconds;
    setElapsed(ratio * totalSeconds);
  }

  useEffect(() => {
    if (!needsPreview) return;
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
          setError(caught instanceof Error ? caught.message : "미디어를 열 수 없습니다.");
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.iv, attachment.key, attachment.mime, needsPreview]);

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
      data-testid={isAudio ? "voice-card" : undefined}
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
      {isAudio ? (
        <div className="flex items-center gap-2">
          {previewUrl ? (
            <>
              <button
                type="button"
                onClick={() => void togglePlay()}
                aria-label={playing ? "일시정지" : "재생"}
                title={playing ? "일시정지" : "재생"}
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors",
                  own
                    ? "bg-white/25 text-accent-contrast hover:bg-white/35"
                    : "bg-accent-600 text-white hover:bg-accent-700",
                )}
              >
                {playing ? (
                  <Pause className="h-4 w-4" aria-hidden />
                ) : (
                  <Play className="ml-0.5 h-4 w-4" aria-hidden />
                )}
              </button>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  data-testid="waveform"
                  onClick={seekFromWaveform}
                  aria-label="재생 위치로 이동"
                  className="relative flex h-9 w-full cursor-pointer items-center"
                >
                  {/* 진행 트랙: 조용한 음성(점선처럼 보이는 파형)에서도 진행률이 또렷하게 보인다. */}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full",
                      own ? "bg-white/25" : "bg-zinc-200",
                    )}
                  >
                    <span
                      style={{ width: `${progress * 100}%` }}
                      className={cn(
                        "block h-full rounded-full transition-[width] duration-150",
                        own ? "bg-white/90" : "bg-accent-600",
                      )}
                    />
                  </span>
                  {attachment.waveform && attachment.waveform.length > 0 ? (
                    <span aria-hidden className="relative flex h-9 w-full items-center gap-[3px]">
                      {attachment.waveform.map((peak, index) => {
                        const bars = attachment.waveform?.length ?? 1;
                        const ratio = bars <= 1 ? 0 : index / (bars - 1);
                        const played = ratio <= progress;
                        return (
                          <span
                            key={index}
                            // 조용한 구간(3% 피크)도 트랙 위에서 보이도록 최소 높이를 준다.
                            style={{ height: `${Math.max(peak, 18)}%` }}
                            className={cn(
                              "w-full rounded-full",
                              played
                                ? own
                                  ? "bg-white/90"
                                  : "bg-accent-600"
                                : own
                                  ? "bg-white/45"
                                  : "bg-zinc-400/70",
                            )}
                          />
                        );
                      })}
                    </span>
                  ) : null}
                </button>
                <span
                  className={cn(
                    "mt-0.5 flex items-center gap-1 text-[11px] leading-4",
                    own ? "text-accent-contrast/80" : "text-zinc-500",
                  )}
                >
                  <span className="shrink-0 tabular-nums">
                    {formatDuration(elapsed)} / {formatDuration(totalSeconds)}
                  </span>
                  <span className="ml-auto shrink-0">{formatBytes(attachment.size)}</span>
                </span>
              </div>
              {/* 네이티브 <audio controls> 는 위아래 여백이 커서 숨기고 위 버튼으로 제어한다. */}
              <audio
                ref={audioRef}
                src={previewUrl}
                preload="metadata"
                className="hidden"
                onLoadedMetadata={syncDuration}
                onTimeUpdate={handleTimeUpdate}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => {
                  setPlaying(false);
                  setElapsed(0);
                }}
              />
              <DownloadIconButton
                own={own}
                downloading={downloading}
                onClick={() => void download()}
              />
            </>
          ) : previewLoading ? (
            <div className="flex h-9 items-center text-xs text-zinc-500">음성 복호화 중…</div>
          ) : null}
        </div>
      ) : null}
      {!isAudio ? (
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
              {attachment.durationSeconds !== undefined
                ? `${formatDuration(attachment.durationSeconds)} · `
                : ""}
              {formatBytes(attachment.size)}
            </span>
          </span>
          <DownloadIconButton
            own={own}
            downloading={downloading}
            onClick={() => void download()}
          />
        </div>
      ) : null}
      {error ? (
        <p className={cn("mt-1.5 text-[11px]", own ? "text-accent-contrast/80" : "text-red-600")}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

type Result =
  | {
      status: "ok";
      text: string;
      attachment: AttachmentPayload | null;
      location: LocationPayload | null;
      link: LinkMessagePayload | null;
    }
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
      const location = attachment ? null : parseLocationPayload(decrypted);
      const link = attachment || location ? null : parseLinkMessage(decrypted);
      return {
        status: "ok",
        // 위치·링크는 카드로만 표시하고 base64/JSON 본문은 화면에 노출하지 않는다.
        text: attachment ? attachment.text : location ? "" : link ? link.text : decrypted,
        attachment,
        location,
        link,
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
  if (result.status !== "ok") return null;
  if (result.location) return "위치 공유";
  return result.text;
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
  readDetail,
  renderMessage,
  edited = false,
  replyTarget,
  replyTargetName,
  reactions = [],
  onReact,
  onReply,
  onEdit,
  onDelete,
  pinned = false,
  onTogglePin,
  viewOnceLocked = false,
  onOpenViewOnce,
  mentionNames = [],
  mentionUser,
}: {
  message: MessageView;
  identity: StoredIdentity;
  own: boolean;
  senderName: string;
  readLabel?: string | undefined;
  /** 읽은 참여자별 시각(툴팁) */
  readDetail?: string | undefined;
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
  pinned?: boolean;
  onTogglePin?: (message: MessageView) => void;
  /** 한 번 보기 메시지에서 수신자가 아직 열지 않은 상태 */
  viewOnceLocked?: boolean;
  onOpenViewOnce?: (message: MessageView) => void;
  /** 참여자 username 목록(멘션 강조용) */
  mentionNames?: string[];
  /** 현재 사용자 username. 이 값이 멘션되면 '나를 멘션' 배지를 표시한다. */
  mentionUser?: string;
}) {
  const [result, setResult] = useState<Result | null>(() => cache.get(message.id) ?? null);
  const [reactionOpen, setReactionOpen] = useState(false);
  const [replyText, setReplyText] = useState<string | null>(null);
  const source = renderMessage ?? message;
  const mentionsMe =
    Boolean(mentionUser) &&
    result?.status === "ok" &&
    Boolean(result.text) &&
    mentionsUser(result.text, mentionUser ?? "");

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    void decryptCached(identity, source).then((value) => {
      if (!cancelled) setResult(value);
      if (value.status !== "ok" || message.kind !== "text") return;
      // 한 번 보기 메시지는 로컬 검색 인덱스에 남기지 않는다(열람 후 삭제되어도 흔적 방지).
      if (message.viewOnce) return;
      // 위치 공유는 좌표(base64) 대신 검색 가능한 문구로만 인덱싱한다.
      const searchable = (
        value.location
          ? ["위치 공유", value.location.label ?? ""]
          : [value.text, value.attachment?.name ?? ""]
      )
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
  const canEdit = own && canAct && result?.status === "ok" && !result.attachment && !result.location;
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
          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
            {senderName}
            {mentionsMe ? (
              <span className="rounded bg-accent-100 px-1 text-[10px] font-medium text-accent-700">
                나를 멘션
              </span>
            ) : null}
          </p>
        ) : null}

        {viewOnceLocked ? (
          <div className="space-y-2">
            <p
              className={cn(
                "flex items-center gap-1.5 text-xs font-medium",
                own ? "text-accent-contrast/90" : "text-zinc-800",
              )}
            >
              <EyeOff className="h-3.5 w-3.5" aria-hidden />
              한 번 보기
            </p>
            <p
              className={cn(
                "text-[11px] leading-relaxed",
                own ? "text-accent-contrast/80" : "text-zinc-500",
              )}
            >
              {viewOnceHint(own)}
            </p>
            <button
              type="button"
              data-testid="view-once-open"
              onClick={() => onOpenViewOnce?.(message)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium",
                own
                  ? "bg-white/20 text-accent-contrast hover:bg-white/30"
                  : "bg-accent-600 text-accent-contrast hover:bg-accent-700",
              )}
            >
              열기
            </button>
          </div>
        ) : result?.status === "ok" ? (
          <div className="space-y-1.5">
            {result.text ? (
              <p className="whitespace-pre-wrap break-words leading-relaxed">
                {tokenizeMessage(result.text, mentionNames).map((token, index) => {
                  switch (token.type) {
                    case "bold":
                      return (
                        <strong key={index} className="font-semibold">
                          {token.text}
                        </strong>
                      );
                    case "code":
                      return (
                        <code
                          key={index}
                          className={cn(
                            "rounded px-1 py-0.5 font-mono text-[0.85em]",
                            own ? "bg-white/20" : "bg-zinc-100 text-zinc-800",
                          )}
                        >
                          {token.text}
                        </code>
                      );
                    case "link":
                      return (
                        <a
                          key={index}
                          href={token.href}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className={cn(
                            "underline underline-offset-2",
                            own ? "text-white" : "text-accent-700",
                          )}
                        >
                          {token.text}
                        </a>
                      );
                    case "mention":
                      return (
                        <span
                          key={index}
                          className={cn(
                            "rounded px-0.5 font-medium",
                            own ? "bg-white/25" : "bg-accent-100 text-accent-800",
                          )}
                        >
                          {token.text}
                        </span>
                      );
                    default:
                      return <Fragment key={index}>{token.text}</Fragment>;
                  }
                })}
              </p>
            ) : null}
            {result.attachment ? (
              <AttachmentCard attachment={result.attachment} own={own} />
            ) : null}
            {result.location ? <LocationCard location={result.location} own={own} /> : null}
            {result.link ? (
              <a
                href={result.link.preview.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                data-testid="link-preview"
                className={cn(
                  "block rounded-lg border px-2.5 py-2 text-xs transition-colors",
                  own
                    ? "border-white/30 bg-white/10 hover:bg-white/15"
                    : "border-zinc-200 bg-zinc-50 hover:bg-zinc-100",
                )}
              >
                <span
                  className={cn(
                    "block truncate text-[10px] uppercase tracking-wide",
                    own ? "text-accent-contrast/70" : "text-zinc-400",
                  )}
                >
                  {result.link.preview.siteName ?? previewHost(result.link.preview.url)}
                </span>
                {result.link.preview.title ? (
                  <span className="mt-0.5 block font-medium">{result.link.preview.title}</span>
                ) : null}
                {result.link.preview.description ? (
                  <span
                    className={cn(
                      "mt-0.5 line-clamp-2 block",
                      own ? "text-accent-contrast/80" : "text-zinc-500",
                    )}
                  >
                    {result.link.preview.description}
                  </span>
                ) : null}
              </a>
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
          title={own && readDetail ? readDetail : undefined}
          className={cn(
            "mt-1 text-right text-[10px]",
            own ? "text-accent-contrast/80" : "text-zinc-400",
          )}
        >
          {formatClock(message.createdAt)}
          {message.viewOnce ? " · 한 번 보기" : ""}
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
                "flex items-center gap-1 rounded-full border px-2 py-1",
                reaction.mine
                  ? "border-accent-400 bg-accent-50 text-accent-700"
                  : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50",
              )}
            >
              <span className="text-lg leading-none">{reaction.emoji}</span>
              <span className="text-xs font-semibold leading-none tabular-nums">
                {reaction.count}
              </span>
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
              if (result?.status !== "ok") return;
              onReply?.(message, result.location ? "위치 공유" : result.text);
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
          <button
            type="button"
            onClick={() => onTogglePin?.(message)}
            aria-label={pinned ? "고정 해제" : "고정"}
            title={pinned ? "고정 해제" : "고정"}
            className={cn(
              "rounded-md p-1 hover:bg-zinc-100",
              pinned ? "text-accent-600" : "text-zinc-400 hover:text-zinc-700",
            )}
          >
            <Pin className={cn("h-3.5 w-3.5", pinned && "fill-current")} />
          </button>
          <button
            type="button"
            onClick={() => onDelete?.(message)}
            aria-label={own ? "전송 취소 또는 삭제" : "나에게만 삭제"}
            title={own ? "전송 취소 또는 삭제" : "나에게만 삭제"}
            className="rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
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
                  className="rounded-full px-1.5 py-1 text-base leading-none hover:bg-zinc-100"
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
