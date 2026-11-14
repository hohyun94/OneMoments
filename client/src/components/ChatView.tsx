import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { ApiError, api } from "../lib/api.ts";
import { encryptMessage, type StoredIdentity } from "../lib/crypto/index.ts";
import { formatDayLabel } from "../lib/format.ts";
import { useRealtime } from "../realtime.tsx";
import type {
  ActiveDevice,
  ConversationSummary,
  MessagePage,
  MessageView,
} from "../types.ts";
import { Alert, Avatar, Button, Spinner, Textarea, cn } from "./ui.tsx";
import { MessageBubble } from "./MessageBubble.tsx";

interface PendingMessage {
  clientMessageId: string;
  plaintext: string;
}

function prependMessage(
  queryClient: ReturnType<typeof useQueryClient>,
  conversationId: string,
  message: MessageView,
): void {
  queryClient.setQueryData<InfiniteData<MessagePage>>(
    ["messages", conversationId],
    (data) => {
      if (!data) return data;
      if (data.pages.some((page) => page.messages.some((item) => item.id === message.id))) {
        return data;
      }
      const first = data.pages[0];
      if (!first) return data;
      const pages = [...data.pages];
      pages[0] = { ...first, messages: [message, ...first.messages] };
      return { ...data, pages };
    },
  );
}

export function ChatView({
  conversation,
  identity,
  currentUserId,
  onBack,
}: {
  conversation: ConversationSummary;
  identity: StoredIdentity;
  currentUserId: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const { status: connection, sendTyping, typingUsers, onlineUsers } = useRealtime();

  const messagesQuery = useInfiniteQuery({
    queryKey: ["messages", conversation.id],
    queryFn: ({ pageParam }) =>
      api<MessagePage>(
        `/api/conversations/${conversation.id}/messages${pageParam ? `?before=${pageParam}` : ""}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const devicesQuery = useQuery({
    queryKey: ["conversation-devices", conversation.id],
    queryFn: () =>
      api<{ devices: ActiveDevice[] }>(
        `/api/conversations/${conversation.id}/devices`,
      ).then((response) => response.devices),
    staleTime: 0,
  });

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const pendingRef = useRef<PendingMessage | null>(null);
  const typingTimerRef = useRef<number | undefined>(undefined);
  const lastTypingAtRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(
    () => (messagesQuery.data?.pages ?? []).flatMap((page) => page.messages),
    [messagesQuery.data],
  );
  const chronological = useMemo(() => [...messages].reverse(), [messages]);
  const latestId = messages[0]?.id;
  const typing = typingUsers(conversation.id);
  const peerOnline = onlineUsers(conversation.id).includes(conversation.peer.id);
  const peerName = conversation.peer.username ?? "삭제된 사용자";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [conversation.id, latestId]);

  useEffect(() => {
    return () => {
      if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    };
  }, []);

  async function loadDevices(): Promise<ActiveDevice[]> {
    return queryClient.fetchQuery({
      queryKey: ["conversation-devices", conversation.id],
      queryFn: () =>
        api<{ devices: ActiveDevice[] }>(
          `/api/conversations/${conversation.id}/devices`,
        ).then((response) => response.devices),
      staleTime: 0,
    });
  }

  async function postEncrypted(
    pending: PendingMessage,
  ): Promise<{ message: MessageView }> {
    const send = async () => {
      const devices = await loadDevices();
      const payload = await encryptMessage({
        identity,
        conversationId: conversation.id,
        clientMessageId: pending.clientMessageId,
        plaintext: pending.plaintext,
        recipients: devices.map((device) => ({
          deviceId: device.id,
          identityPublicKey: device.identityPublicKey,
        })),
      });
      return api<{ message: MessageView }>(
        `/api/conversations/${conversation.id}/messages`,
        { method: "POST", body: payload },
      );
    };

    try {
      return await send();
    } catch (error) {
      if (error instanceof ApiError && error.code === "DEVICE_SET_CHANGED") {
        return send();
      }
      throw error;
    }
  }

  async function deliver(pending: PendingMessage): Promise<void> {
    setSending(true);
    setSendError(null);
    try {
      const response = await postEncrypted(pending);
      prependMessage(queryClient, conversation.id, response.message);
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (pendingRef.current === pending) pendingRef.current = null;
      sendTyping(conversation.id, "stop");
    } catch (error) {
      if (error instanceof ApiError && error.code === "PEER_DELETED") {
        setSendError("상대가 계정을 삭제했습니다.");
      } else if (error instanceof ApiError) {
        setSendError(error.message);
      } else {
        setSendError("메시지를 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.");
      }
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    const pending: PendingMessage = {
      clientMessageId: crypto.randomUUID(),
      plaintext: text,
    };
    pendingRef.current = pending;
    setDraft("");
    void deliver(pending);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    handleSubmit();
  }

  function handleDraftChange(value: string) {
    setDraft(value);
    if (!value.trim()) return;
    const now = Date.now();
    if (now - lastTypingAtRef.current > 2_000) {
      sendTyping(conversation.id, "start");
      lastTypingAtRef.current = now;
    }
    if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(() => {
      sendTyping(conversation.id, "stop");
    }, 2_500);
  }

  const dayGroups: Array<{ day: string; items: MessageView[] }> = [];
  for (const message of chronological) {
    const day = formatDayLabel(message.createdAt);
    const last = dayGroups.at(-1);
    if (last && last.day === day) last.items.push(message);
    else dayGroups.push({ day, items: [message] });
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-zinc-50">
      <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-3 py-3 md:px-5">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onBack}
          aria-label="대화 목록으로"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Avatar name={peerName} />
        <div className="min-w-0 flex-1">
          <h2
            className={cn(
              "truncate text-sm font-semibold",
              conversation.peer.deleted ? "text-zinc-400" : "text-zinc-900",
            )}
          >
            {peerName}
          </h2>
          <p className="flex items-center gap-1.5 text-xs text-zinc-500">
            {typing.length > 0 ? (
              <span className="text-violet-600">입력 중…</span>
            ) : conversation.peer.deleted ? (
              <span>계정 삭제됨</span>
            ) : (
              <>
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    peerOnline ? "bg-emerald-500" : "bg-zinc-300",
                  )}
                />
                {peerOnline ? "온라인" : "오프라인"} · 종단간 암호화
              </>
            )}
          </p>
        </div>
        {connection !== "open" ? (
          <span className="rounded-full bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
            연결 중…
          </span>
        ) : null}
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-4 md:px-6" aria-live="polite">
        {messagesQuery.hasNextPage ? (
          <div className="mb-3 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void messagesQuery.fetchNextPage()}
              disabled={messagesQuery.isFetchingNextPage}
            >
              {messagesQuery.isFetchingNextPage ? <Spinner /> : null}
              이전 메시지
            </Button>
          </div>
        ) : null}

        {messagesQuery.isLoading ? (
          <p className="py-10 text-center text-sm text-zinc-500">메시지를 불러오는 중…</p>
        ) : messagesQuery.isError ? (
          <Alert variant="error">
            <span className="flex items-center justify-between gap-3">
              메시지를 불러오지 못했습니다.
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void messagesQuery.refetch()}
              >
                다시 시도
              </Button>
            </span>
          </Alert>
        ) : chronological.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-zinc-500">
            <p>첫 메시지를 보내보세요.</p>
            <p className="text-xs">메시지는 이 기기에서 암호화되어 전송됩니다.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {dayGroups.map((group) => (
              <div key={group.day} className="space-y-2">
                <div className="flex items-center gap-3 py-1 text-[11px] text-zinc-400">
                  <span className="h-px flex-1 bg-zinc-200" />
                  {group.day}
                  <span className="h-px flex-1 bg-zinc-200" />
                </div>
                {group.items.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    identity={identity}
                    own={message.senderUserId === currentUserId}
                    senderName={
                      message.senderUserId === currentUserId ? "나" : peerName
                    }
                  />
                ))}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-zinc-200 bg-white px-3 py-3 md:px-5"
      >
        {sendError ? (
          <div className="mb-2">
            <Alert variant="error">
              <span className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4" aria-hidden />
                  {sendError}
                </span>
                {pendingRef.current ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const pending = pendingRef.current;
                      if (pending) void deliver(pending);
                    }}
                  >
                    다시 시도
                  </Button>
                ) : null}
              </span>
            </Alert>
          </div>
        ) : null}

        {conversation.peer.deleted ? (
          <p className="py-2 text-center text-sm text-zinc-500">
            이 사용자는 계정을 삭제했습니다.
          </p>
        ) : (
          <div className="flex items-end gap-2">
            <Textarea
              id="message-input"
              rows={1}
              className="max-h-40 min-h-10"
              placeholder="메시지 입력"
              value={draft}
              onChange={(event) => handleDraftChange(event.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="메시지 입력"
            />
            <Button
              type="submit"
              size="icon"
              disabled={sending || !draft.trim()}
              aria-label="전송"
            >
              {sending ? <Spinner /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        )}
        <p className="mt-1 text-[11px] text-zinc-400">
          Enter 전송 · Shift+Enter 줄바꿈 · 종단간 암호화
        </p>
      </form>
    </section>
  );
}
