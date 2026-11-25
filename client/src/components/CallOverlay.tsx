import { useI18n } from "../i18n.tsx";
import {
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  SwitchCamera,
  Video,
  VideoOff,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useCall } from "../calls.tsx";
import { cameraFlipLabel, canShareScreen, remoteScreenLabel, screenShareLabel } from "../lib/call.ts";
import { formatDuration } from "../lib/voice.ts";
import { Button, cn } from "./ui.tsx";

/** 통화 상태를 화면 하단 카드(영상은 전체 화면 패널)로 보여준다. */
export function CallOverlay() {
  const { t, locale } = useI18n();
  const {
    session,
    accept,
    decline,
    hangup,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    flipCamera,
    remoteVideoRef,
    remoteCameraRef,
    localVideoRef,
    localScreenRef,
    remoteVideoStream,
    remoteScreenStream,
    localVideoStream,
    localScreenStream,
  } = useCall();
  const [elapsed, setElapsed] = useState(0);

  const remoteSharing = Boolean(session?.remoteScreenSharing);
  // 무대에는 상대 화면(공유 중이고 트랙이 도착했을 때) 또는 상대 카메라를 붙인다.
  const stageStream = remoteSharing ? (remoteScreenStream ?? remoteVideoStream) : remoteVideoStream;

  // 영상 엘리먼트는 통화 단계에 따라 늦게 마운트되므로, 마운트/스트림 변경 시 붙여준다.
  useEffect(() => {
    const targets: Array<[HTMLVideoElement | null, MediaStream | null]> = [
      [remoteVideoRef.current, stageStream],
      [remoteCameraRef.current, remoteVideoStream],
      [localVideoRef.current, localVideoStream],
      [localScreenRef.current, localScreenStream],
    ];
    for (const [element, stream] of targets) {
      if (!element || element.srcObject === stream) continue;
      element.srcObject = stream;
      if (stream) void element.play().catch(() => undefined);
    }
  }, [
    stageStream,
    remoteVideoStream,
    localVideoStream,
    localScreenStream,
    remoteVideoRef,
    remoteCameraRef,
    localVideoRef,
    localScreenRef,
    session?.phase,
    remoteSharing,
  ]);

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

  const isVideo = session.media === "video";
  // 화면 공유는 데스크톱 브라우저에서만 제공된다(모바일 Safari 등은 API 자체가 없다).
  const screenShareSupported = isVideo && canShareScreen();
  const status =
    session.phase === "incoming"
      ? isVideo
        ? t("call.videoTitle")
        : t("call.incoming")
      : session.phase === "outgoing"
        ? isVideo
          ? t("call.dialingVideo")
          : t("call.dialing")
        : session.phase === "connecting"
          ? t("call.connecting")
          : session.phase === "active"
            ? t("call.inProgress", { duration: formatDuration(elapsed) })
            : session.note ?? t("call.ended");

  // 영상 통화: 발신(수락 전)에는 내 카메라를 크게, 이후에는 원격 영상 + 내 미리보기.
  if (
    isVideo &&
    (session.phase === "outgoing" ||
      session.phase === "connecting" ||
      session.phase === "active")
  ) {
    const ringing = session.phase === "outgoing";
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950/95 p-3">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-black">
          {ringing ? (
            <>
              <video
                ref={localVideoRef}
                data-testid="local-video"
                autoPlay
                playsInline
                muted
                className={cn(
                  "h-full w-full object-cover",
                  !session.screenSharing && "scale-x-[-1]",
                )}
              />
              {!localVideoStream ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-white/80">
                  {t("call.cameraPreparing")}
                </div>
              ) : null}
              <div
                data-testid="peer-video-placeholder"
                className="absolute bottom-3 right-3 flex h-32 w-24 flex-col items-center justify-center gap-1 rounded-xl border border-white/30 bg-black/60 px-1 text-center"
              >
                <Video className="h-5 w-5 text-white/60" aria-hidden />
                <span className="max-w-full truncate text-[10px] text-white/80">
                  {session.peerLabel}
                </span>
                <span className="text-[10px] text-white/50">{t("call.waitingConnection")}</span>
              </div>
            </>
          ) : (
            <>
              <video
                ref={remoteVideoRef}
                data-testid="remote-video"
                autoPlay
                playsInline
                className="h-full w-full object-contain"
              />
              {session.phase === "connecting" ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-white/80">
{t("call.connecting")}
                </div>
              ) : null}
              {remoteSharing ? (
                <>
                  <span
                    data-testid="remote-screen-badge"
                    className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[11px] text-white"
                  >
                    {remoteScreenLabel(true, locale)}
                  </span>
                  {/* 공유 중에는 상대 카메라를 작은 타일로 함께 보여준다. */}
                  <div className="absolute left-3 top-16 h-28 w-20 overflow-hidden rounded-xl border border-white/30 bg-black/70">
                    <video
                      ref={remoteCameraRef}
                      data-testid="remote-camera"
                      autoPlay
                      playsInline
                      className="h-full w-full object-cover"
                    />
                  </div>
                </>
              ) : null}
              {session.screenSharing ? (
                <div className="absolute bottom-3 right-32 h-28 w-20 overflow-hidden rounded-xl border border-white/30 bg-black/70">
                  <video
                    ref={localScreenRef}
                    data-testid="local-screen"
                    autoPlay
                    playsInline
                    muted
                    className="h-full w-full object-cover"
                  />
                </div>
              ) : null}
              <div className="absolute bottom-3 right-3 h-32 w-24 overflow-hidden rounded-xl border border-white/30 bg-black/60">
                <video
                  ref={localVideoRef}
                  data-testid="local-video"
                  autoPlay
                  playsInline
                  muted
                  className={cn(
                    "h-full w-full object-cover",
                    !session.screenSharing && "scale-x-[-1]",
                  )}
                />
                {session.screenSharing ? (
                  <span
                    data-testid="screen-share-badge"
                    className="absolute inset-x-0 bottom-0 bg-black/70 py-0.5 text-center text-[10px] text-white"
                  >
                    {t("call.sharing")}
                  </span>
                ) : null}
              </div>
            </>
          )}
          <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1 text-xs text-white">
            <span className="truncate">{session.peerLabel}</span>
            <span aria-hidden>·</span>
            <span data-testid="call-status">{status}</span>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-center gap-3">
          {ringing ? null : (
            <Button
              type="button"
              size="icon"
              onClick={toggleMute}
              aria-label={t(session.muted ? "call.unmute" : "call.mute")}
              aria-pressed={session.muted}
              title={t(session.muted ? "call.unmute" : "call.mute")}
              className="bg-white/10 text-white hover:bg-white/20"
            >
              {session.muted ? (
                <MicOff className="h-4 w-4" aria-hidden />
              ) : (
                <Mic className="h-4 w-4" aria-hidden />
              )}
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            onClick={toggleCamera}
            aria-label={t(session.cameraOff ? "call.cameraOn" : "call.cameraOff")}
            aria-pressed={session.cameraOff}
            title={t(session.cameraOff ? "call.cameraOn" : "call.cameraOff")}
            className="bg-white/10 text-white hover:bg-white/20"
          >
            {session.cameraOff ? (
              <VideoOff className="h-4 w-4" aria-hidden />
            ) : (
              <Video className="h-4 w-4" aria-hidden />
            )}
          </Button>
          {ringing || !screenShareSupported ? null : (
            <Button
              type="button"
              size="icon"
              onClick={() => void toggleScreenShare()}
              aria-label={screenShareLabel(session.screenSharing, locale)}
              aria-pressed={session.screenSharing}
              title={screenShareLabel(session.screenSharing, locale)}
              className="bg-white/10 text-white hover:bg-white/20"
            >
              {session.screenSharing ? (
                <ScreenShareOff className="h-4 w-4" aria-hidden />
              ) : (
                <ScreenShare className="h-4 w-4" aria-hidden />
              )}
            </Button>
          )}
          {ringing || !session.canFlipCamera ? null : (
            <Button
              type="button"
              size="icon"
              onClick={() => void flipCamera()}
              aria-label={cameraFlipLabel(session.facing, locale)}
              title={cameraFlipLabel(session.facing, locale)}
              className="bg-white/10 text-white hover:bg-white/20"
            >
              <SwitchCamera className="h-4 w-4" aria-hidden />
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            variant="destructive"
            onClick={hangup}
            aria-label={t(ringing ? "call.cancel" : "call.end")}
            title={t(ringing ? "call.cancel" : "call.end")}
          >
            <PhoneOff className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-3">
      <div
        data-testid="call-overlay"
        role={session.phase === "incoming" ? "dialog" : undefined}
        aria-label={session.phase === "incoming" ? t("call.incoming") : undefined}
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
                aria-label={t(session.muted ? "call.unmute" : "call.mute")}
                aria-pressed={session.muted}
                title={t(session.muted ? "call.unmute" : "call.mute")}
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
                aria-label={t("call.end")}
                title={t("call.end")}
              >
                <PhoneOff className="h-4 w-4" aria-hidden />
              </Button>
            </span>
          ) : null}
        </div>

        {session.phase === "incoming" ? (
          <div className="mt-3 flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={decline}>
{t("call.decline")}
            </Button>
            <Button type="button" className="flex-1" onClick={() => void accept()}>
{t("call.accept")}
            </Button>
          </div>
        ) : null}

        {session.phase === "outgoing" || session.phase === "connecting" ? (
          <div className="mt-3 flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={hangup}>
{t("call.cancel")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
