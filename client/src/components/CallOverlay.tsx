import { Mic, MicOff, PhoneCall, PhoneOff } from "lucide-react";
import { useEffect, useState } from "react";

import { useCall } from "../calls.tsx";
import { formatDuration } from "../lib/voice.ts";
import { Button, cn } from "./ui.tsx";

/** 통화 상태를 화면 하단 카드로 보여준다(수신 벨/발신/통화 중/종료). */
export function CallOverlay() {
  const { session, accept, decline, hangup, toggleMute } = useCall();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const connectedAt = session?.connectedAt ?? null;
    if (session?.phase !== "active" || !connectedAt) {
      setElapsed(0);
      return;
    }
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - connectedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [session?.phase, session?.connectedAt]);

  if (!session) return null;

  const status =
    session.phase === "incoming"
      ? "수신 전화"
      : session.phase === "outgoing"
        ? "발신 중…"
        : session.phase === "connecting"
          ? "연결 중…"
          : session.phase === "active"
            ? `통화 중 · ${formatDuration(elapsed)}`
            : session.note ?? "통화 종료";

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-3">
      <div
        data-testid="call-overlay"
        role={session.phase === "incoming" ? "dialog" : undefined}
        aria-label={session.phase === "incoming" ? "수신 전화" : undefined}
        className={cn(
          "pointer-events-auto w-full max-w-sm rounded-2xl border bg-white p-3 shadow-xl",
          session.phase === "incoming" ? "border-accent-300" : "border-zinc-200",
        )}
      >
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
              session.phase === "ended"
                ? "bg-zinc-200 text-zinc-600"
                : "bg-accent-600 text-accent-contrast",
            )}
          >
            <PhoneCall className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-zinc-900">{session.peerLabel}</p>
            <p data-testid="call-status" className="truncate text-xs text-zinc-500">
              {status}
            </p>
          </div>
          {session.phase === "active" ? (
            <span className="flex items-center gap-1">
              <Button
                type="button"
                size="icon"
                variant={session.muted ? "outline" : "ghost"}
                onClick={toggleMute}
                aria-label={session.muted ? "음소거 해제" : "음소거"}
                aria-pressed={session.muted}
                title={session.muted ? "음소거 해제" : "음소거"}
              >
                {session.muted ? (
                  <MicOff className="h-4 w-4" aria-hidden />
                ) : (
                  <Mic className="h-4 w-4" aria-hidden />
                )}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="destructive"
                onClick={hangup}
                aria-label="통화 종료"
                title="통화 종료"
              >
                <PhoneOff className="h-4 w-4" aria-hidden />
              </Button>
            </span>
          ) : null}
        </div>

        {session.phase === "incoming" ? (
          <div className="mt-3 flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={decline}>
              거절
            </Button>
            <Button type="button" className="flex-1" onClick={() => void accept()}>
              수락
            </Button>
          </div>
        ) : null}

        {session.phase === "outgoing" || session.phase === "connecting" ? (
          <div className="mt-3 flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={hangup}>
              통화 취소
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
