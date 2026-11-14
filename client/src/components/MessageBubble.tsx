import { ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";

import {
  DecryptionError,
  decryptMessage,
  type StoredIdentity,
} from "../lib/crypto/index.ts";
import { formatClock } from "../lib/format.ts";
import type { MessageView } from "../types.ts";
import { cn } from "./ui.tsx";

type Result =
  | { status: "ok"; text: string }
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
    .then((text): Result => ({ status: "ok", text }))
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
          <p className="whitespace-pre-wrap break-words leading-relaxed">{result.text}</p>
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
