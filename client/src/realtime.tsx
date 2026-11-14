import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { MessagePage, MessageView, ServerFrame } from "./types.ts";

type MessagePages = InfiniteData<MessagePage>;

export type RealtimeStatus = "connecting" | "open" | "closed";

interface RealtimeContextValue {
  status: RealtimeStatus;
  sendTyping: (conversationId: string, state: "start" | "stop") => void;
  typingUsers: (conversationId: string) => string[];
  onlineUsers: (conversationId: string) => string[];
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function RealtimeProvider({
  enabled,
  conversationIds,
  children,
}: {
  enabled: boolean;
  conversationIds: string[];
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const socketRef = useRef<WebSocket | null>(null);
  const conversationIdsRef = useRef(conversationIds);
  conversationIdsRef.current = conversationIds;

  const [status, setStatus] = useState<RealtimeStatus>(enabled ? "connecting" : "closed");
  const [revision, setRevision] = useState(0);

  const typingRef = useRef(new Map<string, Set<string>>());
  const typingTimersRef = useRef(new Map<string, number>());
  const onlineRef = useRef(new Map<string, Set<string>>());

  const subscriptionKey = useMemo(
    () => [...conversationIds].sort().join(","),
    [conversationIds],
  );

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: number | undefined;

    const bump = () => setRevision((value) => value + 1);

    const addMessage = (message: MessageView) => {
      queryClient.setQueryData<MessagePages>(
        ["messages", message.conversationId],
        (data) => {
          if (!data) return data;
          const exists = data.pages.some((page) =>
            page.messages.some((item) => item.id === message.id),
          );
          if (exists) return data;
          const first = data.pages[0];
          if (!first) return data;
          const pages = [...data.pages];
          pages[0] = { ...first, messages: [message, ...first.messages] };
          return { ...data, pages };
        },
      );
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    };

    const handleFrame = (frame: ServerFrame) => {
      switch (frame.type) {
        case "ready": {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({
                type: "subscribe",
                conversationIds: conversationIdsRef.current,
              }),
            );
          }
          break;
        }
        case "message.created": {
          addMessage(frame.message);
          break;
        }
        case "typing": {
          const users = typingRef.current.get(frame.conversationId) ?? new Set<string>();
          const key = `${frame.conversationId}:${frame.userId}`;
          const existing = typingTimersRef.current.get(key);
          if (existing) window.clearTimeout(existing);

          if (frame.state === "start") {
            users.add(frame.userId);
            const handle = window.setTimeout(() => {
              typingRef.current.get(frame.conversationId)?.delete(frame.userId);
              typingTimersRef.current.delete(key);
              bump();
            }, 5_000);
            typingTimersRef.current.set(key, handle);
          } else {
            users.delete(frame.userId);
          }
          typingRef.current.set(frame.conversationId, users);
          bump();
          break;
        }
        case "presence": {
          const users = onlineRef.current.get(frame.conversationId) ?? new Set<string>();
          if (frame.state === "online") users.add(frame.userId);
          else users.delete(frame.userId);
          onlineRef.current.set(frame.conversationId, users);
          bump();
          break;
        }
        case "error": {
          console.warn(`WS error: ${frame.code}`);
          break;
        }
        default:
          break;
      }
    };

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) {
          socket?.close();
          return;
        }
        retry = 0;
        setStatus("open");
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "subscribe",
              conversationIds: conversationIdsRef.current,
            }),
          );
        }
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        void queryClient.invalidateQueries({ queryKey: ["messages"] });
      };

      socket.onmessage = (event) => {
        try {
          handleFrame(JSON.parse(String(event.data)) as ServerFrame);
        } catch {
          // 잘못된 프레임은 무시한다.
        }
      };

      socket.onclose = () => {
        setStatus("closed");
        if (disposed) return;
        const delay = Math.min(30_000, 1_000 * 2 ** retry);
        retry += 1;
        timer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      for (const handle of typingTimersRef.current.values()) window.clearTimeout(handle);
      typingTimersRef.current.clear();
      socket?.close();
      socketRef.current = null;
    };
  }, [enabled, queryClient]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!enabled || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({ type: "subscribe", conversationIds: conversationIdsRef.current }),
    );
  }, [enabled, subscriptionKey]);

  const sendTyping = (conversationId: string, state: "start" | "stop") => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "typing", conversationId, state }));
    }
  };

  const value = useMemo<RealtimeContextValue>(
    () => ({
      status,
      sendTyping,
      typingUsers: (conversationId) => [
        ...(typingRef.current.get(conversationId) ?? []),
      ],
      onlineUsers: (conversationId) => [
        ...(onlineRef.current.get(conversationId) ?? []),
      ],
    }),
    // revision 은 타이핑/접속 상태 변경 시 재계산을 트리거한다.
    [status, revision],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error("useRealtime must be used inside RealtimeProvider");
  return value;
}
