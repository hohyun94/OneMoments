import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { CallOverlay } from "./components/CallOverlay.tsx";
import { api } from "./lib/api.ts";
import { callDeclineNote, callEndNote, normalizeIceServers } from "./lib/call.ts";
import { useRealtime } from "./realtime.tsx";
import type {
  CallConfig,
  CallServerFrame,
  CallSignal,
  ConversationSummary,
  ServerFrame,
} from "./types.ts";

export type CallPhase = "idle" | "outgoing" | "incoming" | "connecting" | "active" | "ended";

export interface CallSession {
  callId: string;
  conversationId: string;
  peerUserId: string;
  peerLabel: string;
  direction: "outgoing" | "incoming";
  phase: CallPhase;
  muted: boolean;
  /** 연결 완료 시각(ms). 통화 시간 표시에 쓴다. */
  connectedAt: number | null;
  /** 종료/거절 안내 문구. */
  note: string | null;
}

interface CallContextValue {
  enabled: boolean;
  session: CallSession | null;
  startCall: (input: {
    conversationId: string;
    peerUserId: string;
    peerLabel: string;
  }) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => void;
  hangup: () => void;
  toggleMute: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

const ENDED_VISIBLE_MS = 4_000;
/** 연결(ICE)이 붙기까지 기다리는 최대 시간. */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * 1:1 음성 통화 상태와 WebRTC 연결을 관리한다.
 *
 * 서버는 시그널링만 중계하며(저장 없음), 오디오는 브라우저 간 P2P 또는 TURN 으로 흐른다.
 * 통화 상태는 메모리에서만 유지되므로 새로고침하면 통화가 종료된다(docs/29-voice-call.md).
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const { sendFrame, subscribeFrames } = useRealtime();
  const queryClient = useQueryClient();

  const [config, setConfig] = useState<CallConfig | null>(null);
  const [session, setSession] = useState<CallSession | null>(null);

  const sessionRef = useRef<CallSession | null>(null);
  sessionRef.current = session;
  const configRef = useRef<CallConfig | null>(null);
  configRef.current = config;

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const pendingOfferRef = useRef<CallSignal["description"] | null>(null);
  const ringTimerRef = useRef<number | undefined>(undefined);
  const endedTimerRef = useRef<number | undefined>(undefined);
  const connectTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api<CallConfig>("/api/call/config")
      .then((value) => {
        if (!cancelled) {
          setConfig({ ...value, iceServers: normalizeIceServers(value.iceServers) });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const clearTimers = useCallback(() => {
    if (ringTimerRef.current) window.clearTimeout(ringTimerRef.current);
    ringTimerRef.current = undefined;
    if (endedTimerRef.current) window.clearTimeout(endedTimerRef.current);
    endedTimerRef.current = undefined;
    if (connectTimerRef.current) window.clearTimeout(connectTimerRef.current);
    connectTimerRef.current = undefined;
  }, []);

  const releaseMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    pendingCandidatesRef.current = [];
    pendingOfferRef.current = null;
  }, []);

  const finish = useCallback(
    (note: string) => {
      clearTimers();
      releaseMedia();
      setSession((current) => {
        if (!current) return current;
        const callId = current.callId;
        endedTimerRef.current = window.setTimeout(() => {
          setSession((value) => (value?.callId === callId ? null : value));
        }, ENDED_VISIBLE_MS);
        return { ...current, phase: "ended", note };
      });
    },
    [clearTimers, releaseMedia],
  );

  const sendSignal = useCallback(
    (signal: CallSignal) => {
      const current = sessionRef.current;
      if (!current) return;
      sendFrame({
        type: "call.signal",
        conversationId: current.conversationId,
        callId: current.callId,
        signal,
      });
    },
    [sendFrame],
  );

  const flushCandidates = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc?.remoteDescription) return;
    const queued = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of queued) {
      await pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }, []);

  /** ICE 연결이 일정 시간 안에 붙지 않으면 실패로 처리해 UI 가 멈춰 있지 않게 한다. */
  const startConnectTimeout = useCallback(
    (callId: string) => {
      if (connectTimerRef.current) window.clearTimeout(connectTimerRef.current);
      connectTimerRef.current = window.setTimeout(() => {
        const current = sessionRef.current;
        if (!current || current.callId !== callId) return;
        if (current.phase !== "connecting") return;
        sendFrame({
          type: "call.end",
          conversationId: current.conversationId,
          callId,
          reason: "failed",
        });
        finish("연결에 실패했습니다. 네트워크를 확인해 주세요.");
      }, CONNECT_TIMEOUT_MS);
    },
    [finish, sendFrame],
  );

  const prepareConnection = useCallback(
    async (cfg: CallConfig, callId: string): Promise<RTCPeerConnection | null> => {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
        finish("이 브라우저는 음성 통화를 지원하지 않습니다.");
        return null;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch {
        finish("마이크 권한이 필요합니다.");
        return null;
      }
      localStreamRef.current = stream;
      const pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
      pcRef.current = pc;
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        if (sessionRef.current?.callId !== callId) return;
        sendSignal({
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment,
          },
        });
      };
      pc.ontrack = (event) => {
        const remote = remoteAudioRef.current;
        if (!remote) return;
        remote.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void remote.play().catch(() => undefined);
      };
      pc.onconnectionstatechange = () => {
        const current = sessionRef.current;
        if (!current || current.callId !== callId) return;
        if (pc.connectionState === "connected") {
          if (connectTimerRef.current) window.clearTimeout(connectTimerRef.current);
          connectTimerRef.current = undefined;
          setSession((value) =>
            value?.callId === callId
              ? {
                  ...value,
                  phase: "active",
                  connectedAt: value.connectedAt ?? Date.now(),
                  note: null,
                }
              : value,
          );
        } else if (pc.connectionState === "failed") {
          sendFrame({
            type: "call.end",
            conversationId: current.conversationId,
            callId,
            reason: "failed",
          });
          finish("연결에 실패했습니다.");
        }
      };
      return pc;
    },
    [finish, sendFrame, sendSignal],
  );

  const ensureConfig = useCallback(async (): Promise<CallConfig | null> => {
    const existing = configRef.current;
    if (existing) return existing.enabled ? existing : null;
    try {
      const value = await api<CallConfig>("/api/call/config");
      const normalized: CallConfig = {
        ...value,
        iceServers: normalizeIceServers(value.iceServers),
      };
      configRef.current = normalized;
      setConfig(normalized);
      return normalized.enabled ? normalized : null;
    } catch {
      return null;
    }
  }, []);

  const findPeerLabel = useCallback(
    (conversationId: string, fromUserId: string): string => {
      const conversations = queryClient.getQueryData<ConversationSummary[]>(["conversations"]);
      const conversation = conversations?.find((item) => item.id === conversationId);
      const member =
        conversation?.members.find((item) => item.id === fromUserId) ??
        (conversation?.peer?.id === fromUserId ? conversation.peer : null);
      return member?.username ? `@${member.username}` : "상대";
    },
    [queryClient],
  );

  const declineInternal = useCallback(
    (callId: string, conversationId: string, reason: "declined" | "busy" | "unsupported") => {
      sendFrame({ type: "call.decline", conversationId, callId, reason });
    },
    [sendFrame],
  );

  // 발신 시작
  const startCall = useCallback(
    async (input: { conversationId: string; peerUserId: string; peerLabel: string }) => {
      const current = sessionRef.current;
      if (current && current.phase !== "ended" && current.phase !== "idle") return;
      const cfg = await ensureConfig();
      if (!cfg) {
        setSession({
          callId: crypto.randomUUID(),
          conversationId: input.conversationId,
          peerUserId: input.peerUserId,
          peerLabel: input.peerLabel,
          direction: "outgoing",
          phase: "ended",
          muted: false,
          connectedAt: null,
          note: "음성 통화를 사용할 수 없습니다.",
        });
        return;
      }
      clearTimers();
      const callId = crypto.randomUUID();
      setSession({
        callId,
        conversationId: input.conversationId,
        peerUserId: input.peerUserId,
        peerLabel: input.peerLabel,
        direction: "outgoing",
        phase: "outgoing",
        muted: false,
        connectedAt: null,
        note: null,
      });
      sendFrame({
        type: "call.invite",
        conversationId: input.conversationId,
        callId,
        media: "audio",
      });
      ringTimerRef.current = window.setTimeout(() => {
        const latest = sessionRef.current;
        if (latest?.callId !== callId || latest.phase !== "outgoing") return;
        sendFrame({ type: "call.cancel", conversationId: input.conversationId, callId });
        finish("응답이 없어 통화를 종료했습니다.");
      }, cfg.ringTimeoutSeconds * 1000);
    },
    [clearTimers, ensureConfig, finish, sendFrame],
  );

  // 수락
  const accept = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || current.phase !== "incoming") return;
    const cfg = await ensureConfig();
    if (!cfg) {
      declineInternal(current.callId, current.conversationId, "unsupported");
      finish("음성 통화를 사용할 수 없습니다.");
      return;
    }
    const pc = await prepareConnection(cfg, current.callId);
    if (!pc) {
      declineInternal(current.callId, current.conversationId, "unsupported");
      return;
    }
    clearTimers();
    setSession((value) =>
      value?.callId === current.callId ? { ...value, phase: "connecting" } : value,
    );
    startConnectTimeout(current.callId);
    sendFrame({
      type: "call.accept",
      conversationId: current.conversationId,
      callId: current.callId,
      media: "audio",
    });
    // 상대 offer 가 먼저 도착해 있으면 바로 적용한다.
    const offer = pendingOfferRef.current;
    if (!offer) return;
    pendingOfferRef.current = null;
    try {
      await pc.setRemoteDescription(offer as RTCSessionDescriptionInit);
      await flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ description: { type: "answer", sdp: answer.sdp ?? "" } });
    } catch {
      finish("연결에 실패했습니다.");
    }
  }, [
    clearTimers,
    declineInternal,
    ensureConfig,
    finish,
    flushCandidates,
    prepareConnection,
    sendFrame,
    sendSignal,
    startConnectTimeout,
  ]);

  const decline = useCallback(() => {
    const current = sessionRef.current;
    if (!current || current.phase !== "incoming") return;
    declineInternal(current.callId, current.conversationId, "declined");
    finish("통화를 거절했습니다.");
  }, [declineInternal, finish]);

  const hangup = useCallback(() => {
    const current = sessionRef.current;
    if (!current) return;
    if (current.phase === "outgoing") {
      sendFrame({
        type: "call.cancel",
        conversationId: current.conversationId,
        callId: current.callId,
      });
    } else if (current.phase !== "ended") {
      sendFrame({
        type: "call.end",
        conversationId: current.conversationId,
        callId: current.callId,
        reason: "hangup",
      });
    }
    finish("통화를 종료했습니다.");
  }, [finish, sendFrame]);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const tracks = stream.getAudioTracks();
    const nextMuted = tracks.some((track) => track.enabled);
    for (const track of tracks) track.enabled = !nextMuted;
    setSession((current) => (current ? { ...current, muted: nextMuted } : current));
  }, []);

  // 서버 시그널링 처리
  useEffect(() => {
    const handle = (frame: ServerFrame) => {
      if (!frame.type.startsWith("call.")) return;
      const call = frame as CallServerFrame;
      const current = sessionRef.current;

      if (call.type === "call.invite") {
        if (current && current.phase !== "ended" && current.phase !== "idle") {
          // 이미 통화 중이면 상대에게 busy 를 알린다.
          declineInternal(call.callId, call.conversationId, "busy");
          return;
        }
        clearTimers();
        setSession({
          callId: call.callId,
          conversationId: call.conversationId,
          peerUserId: call.fromUserId,
          peerLabel: findPeerLabel(call.conversationId, call.fromUserId),
          direction: "incoming",
          phase: "incoming",
          muted: false,
          connectedAt: null,
          note: null,
        });
        return;
      }

      if (!current || current.callId !== call.callId) return;

      switch (call.type) {
        case "call.accepted": {
          if (current.direction === "incoming") {
            // 다른 기기에서 먼저 받았다.
            finish("다른 기기에서 통화를 받았습니다.");
            return;
          }
          const cfg = configRef.current;
          if (!cfg || current.phase !== "outgoing") return;
          void (async () => {
            const pc = await prepareConnection(cfg, call.callId);
            if (!pc) return;
            clearTimers();
            setSession((value) =>
              value?.callId === call.callId ? { ...value, phase: "connecting" } : value,
            );
            startConnectTimeout(call.callId);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendSignal({ description: { type: "offer", sdp: offer.sdp ?? "" } });
          })();
          return;
        }
        case "call.declined": {
          if (current.direction === "outgoing") finish(callDeclineNote(call.reason));
          return;
        }
        case "call.cancelled": {
          if (current.direction === "incoming" && current.phase === "incoming") {
            finish("상대가 통화를 취소했습니다.");
          }
          return;
        }
        case "call.ended": {
          finish(callEndNote(call.reason, true));
          return;
        }
        case "call.signal": {
          const signal = call.signal;
          void (async () => {
            const pc = pcRef.current;
            if (signal.description) {
              if (signal.description.type === "offer") {
                if (!pc) {
                  // 수락 전에 도착한 offer 는 보관한다.
                  pendingOfferRef.current = signal.description;
                  return;
                }
                try {
                  await pc.setRemoteDescription(signal.description as RTCSessionDescriptionInit);
                  await flushCandidates();
                  const answer = await pc.createAnswer();
                  await pc.setLocalDescription(answer);
                  sendSignal({ description: { type: "answer", sdp: answer.sdp ?? "" } });
                } catch {
                  finish("연결에 실패했습니다.");
                }
                return;
              }
              if (signal.description.type === "answer" && pc) {
                try {
                  await pc.setRemoteDescription(signal.description as RTCSessionDescriptionInit);
                  await flushCandidates();
                } catch {
                  finish("연결에 실패했습니다.");
                }
              }
              return;
            }
            if (signal.candidate) {
              if (!pc?.remoteDescription) {
                pendingCandidatesRef.current.push(signal.candidate as RTCIceCandidateInit);
                return;
              }
              await pc
                .addIceCandidate(signal.candidate as RTCIceCandidateInit)
                .catch(() => undefined);
            }
          })();
          return;
        }
      }
    };
    return subscribeFrames(handle);
  }, [
    clearTimers,
    declineInternal,
    findPeerLabel,
    finish,
    flushCandidates,
    prepareConnection,
    sendSignal,
    startConnectTimeout,
    subscribeFrames,
  ]);

  // 언마운트 시 정리
  useEffect(() => {
    return () => {
      clearTimers();
      releaseMedia();
    };
  }, [clearTimers, releaseMedia]);

  const value = useMemo<CallContextValue>(
    () => ({
      enabled: Boolean(config?.enabled),
      session,
      startCall,
      accept,
      decline,
      hangup,
      toggleMute,
    }),
    [accept, config?.enabled, decline, hangup, session, startCall, toggleMute],
  );

  return (
    <CallContext.Provider value={value}>
      {children}
      {/* 원격 오디오 출력(수락 제스처 이후 재생된다). */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      <CallOverlay />
    </CallContext.Provider>
  );
}

export function useCall(): CallContextValue {
  const value = useContext(CallContext);
  if (!value) throw new Error("useCall must be used inside CallProvider");
  return value;
}

