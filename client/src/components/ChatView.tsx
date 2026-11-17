import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  Bell,
  BellOff,
  Clock,
  Paperclip,
  Send,
  Settings,
  ShieldCheck,
  UserPlus,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { ApiError, api } from "../lib/api.ts";
import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  commitSenderKeyMessage,
  encryptAttachment,
  encodeAttachmentPayload,
  encryptMessage,
  prepareSenderKeyMessage,
  rememberHistoryKey,
  type PreparedSenderKeyMessage,
  type StoredIdentity,
} from "../lib/crypto/index.ts";
import { formatBytes, formatDayLabel } from "../lib/format.ts";
import { autoDeleteLabel } from "../lib/autoDelete.ts";
import { useRealtime } from "../realtime.tsx";
import type {
  ActiveDevice,
  ConversationSummary,
  MessagePage,
  MessageView,
  ReadReceipt,
} from "../types.ts";
import { Alert, Avatar, Button, Dialog, Spinner, Textarea, cn } from "./ui.tsx";
import { MessageBubble, deleteDecryptedMessageCache } from "./MessageBubble.tsx";
import { GroupMembersDialog } from "./GroupMembersDialog.tsx";
import { GroupSettingsDialog } from "./GroupSettingsDialog.tsx";
import { AutoDeleteDialog } from "./AutoDeleteDialog.tsx";
import { computeSafetyNumber, type SafetyNumber } from "../lib/safety.ts";

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
  onLeft,
}: {
  conversation: ConversationSummary;
  identity: StoredIdentity;
  currentUserId: string;
  onBack: () => void;
  onLeft: () => void;
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

  const readsQuery = useQuery({
    queryKey: ["conversation-reads", conversation.id],
    queryFn: () =>
      api<{ reads: ReadReceipt[] }>(
        `/api/conversations/${conversation.id}/reads`,
      ).then((response) => response.reads),
    staleTime: 2_000,
    refetchInterval: 5_000,
  });

  const devicesQuery = useQuery({
    queryKey: ["conversation-devices", conversation.id],
    queryFn: () =>
      api<{ devices: ActiveDevice[] }>(
        `/api/conversations/${conversation.id}/devices`,
      ).then((response) => response.devices),
    staleTime: 0,
    refetchInterval: 60_000,
  });

  const muteMutation = useMutation({
    mutationFn: (muted: boolean) =>
      api<{ muted: boolean }>(`/api/conversations/${conversation.id}/notification`, {
        method: "PUT",
        body: { muted },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [safety, setSafety] = useState<SafetyNumber | null>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [safetyChanged, setSafetyChanged] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoDeleteOpen, setAutoDeleteOpen] = useState(false);
  const pendingRef = useRef<PendingMessage | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastMarkedReadRef = useRef<string | null>(null);
  const typingTimerRef = useRef<number | undefined>(undefined);
  const lastTypingAtRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(
    () => (messagesQuery.data?.pages ?? []).flatMap((page) => page.messages),
    [messagesQuery.data],
  );
  const chronological = useMemo(() => [...messages].reverse(), [messages]);
  const latestId = messages[0]?.id;

  // 자동 삭제로 서버에서 사라진 메시지의 복호화 캐시도 함께 제거한다.
  const decryptedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    decryptedIdsRef.current = new Set();
  }, [conversation.id]);
  useEffect(() => {
    const current = new Set(chronological.map((message) => message.id));
    for (const id of decryptedIdsRef.current) {
      if (!current.has(id)) deleteDecryptedMessageCache(id);
    }
    decryptedIdsRef.current = current;
  }, [chronological]);
  const typing = typingUsers(conversation.id);
  const isGroup = conversation.kind === "group";
  const otherReads = useMemo(
    () => (readsQuery.data ?? []).filter((read) => read.userId !== currentUserId),
    [readsQuery.data, currentUserId],
  );

  function readLabelFor(message: MessageView): string | undefined {
    if (!readsQuery.isSuccess) return undefined;
    const createdAt = Date.parse(message.createdAt);
    if (isGroup) {
      const count = otherReads.filter(
        (read) => Date.parse(read.readAt) >= createdAt,
      ).length;
      return count > 0 ? `${count}명 읽음` : "안 읽음";
    }
    const peerRead = otherReads[0];
    return peerRead && Date.parse(peerRead.readAt) >= createdAt
      ? "읽음"
      : "안 읽음";
  }
  const peer = conversation.peer;
  const peerName = isGroup
    ? (conversation.name ?? "그룹")
    : (peer?.username ?? "삭제된 사용자");
  const peerDeleted = !isGroup && Boolean(peer?.deleted);
  const memberNames = useMemo(
    () =>
      new Map(
        conversation.members.map((member) => [
          member.id,
          member.username ?? "삭제된 사용자",
        ]),
      ),
    [conversation.members],
  );
  const typingNames = typing
    .map((userId) => memberNames.get(userId))
    .filter((name): name is string => Boolean(name));
  const peerOnline =
    !isGroup && peer ? onlineUsers(conversation.id).includes(peer.id) : false;

  useEffect(() => {
    setDraft("");
    setAttachment(null);
    setAttachmentError(null);
    setSendError(null);
    pendingRef.current = null;
    lastMarkedReadRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [conversation.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [conversation.id, latestId]);

  useEffect(() => {
    if (!latestId || lastMarkedReadRef.current === latestId) return;
    lastMarkedReadRef.current = latestId;
    void api(`/api/conversations/${conversation.id}/read`, {
      method: "PUT",
      body: { messageId: latestId },
    })
      .then(() => queryClient.invalidateQueries({ queryKey: ["conversations"] }))
      .catch(() => {
        lastMarkedReadRef.current = null;
      });
  }, [conversation.id, latestId, queryClient]);

  useEffect(() => {
    const devices = devicesQuery.data;
    if (!devices || devices.length === 0) {
      setSafety(null);
      setSafetyChanged(false);
      return;
    }
    let cancelled = false;
    void computeSafetyNumber(devices)
      .then((value) => {
        if (cancelled || !value) return;
        setSafety(value);
        const storageKey = `onemoments:safety:${conversation.id}`;
        const stored = localStorage.getItem(storageKey);
        if (!stored) {
          localStorage.setItem(storageKey, value.hex);
          setSafetyChanged(false);
        } else {
          setSafetyChanged(stored !== value.hex);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversation.id, devicesQuery.data]);

  function acknowledgeSafetyChange(): void {
    if (!safety) return;
    localStorage.setItem(`onemoments:safety:${conversation.id}`, safety.hex);
    setSafetyChanged(false);
  }

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
  ): Promise<{ message: MessageView; prepared: PreparedSenderKeyMessage | null }> {
    let prepared: PreparedSenderKeyMessage | null = null;
    const send = async () => {
      const devices = await loadDevices();
      if (conversation.kind === "group") {
        prepared = await prepareSenderKeyMessage({
          identity,
          conversationId: conversation.id,
          clientMessageId: pending.clientMessageId,
          plaintext: pending.plaintext,
          devices: devices.map((device) => ({
            deviceId: device.id,
            identityPublicKey: device.identityPublicKey,
            signedPreKeyId: device.signedPreKeyId,
            signedPreKeyPublicKey: device.signedPreKeyPublicKey,
            oneTimePreKeyId: device.oneTimePreKeyId,
            oneTimePreKeyPublicKey: device.oneTimePreKeyPublicKey,
          })),
          memberCount: conversation.memberCount,
        });
        const response = await api<{ message: MessageView }>(
          `/api/conversations/${conversation.id}/messages`,
          { method: "POST", body: prepared.payload },
        );
        return response;
      }

      const payload = await encryptMessage({
        identity,
        conversationId: conversation.id,
        clientMessageId: pending.clientMessageId,
        plaintext: pending.plaintext,
        recipients: devices.map((device) => ({
          deviceId: device.id,
          identityPublicKey: device.identityPublicKey,
          signedPreKeyId: device.signedPreKeyId,
          signedPreKeyPublicKey: device.signedPreKeyPublicKey,
          oneTimePreKeyId: device.oneTimePreKeyId,
          oneTimePreKeyPublicKey: device.oneTimePreKeyPublicKey,
        })),
      });
      const response = await api<{ message: MessageView }>(
        `/api/conversations/${conversation.id}/messages`,
        { method: "POST", body: payload },
      );
      return response;
    };

    try {
      const response = await send();
      return { ...response, prepared };
    } catch (error) {
      if (error instanceof ApiError && error.code === "DEVICE_SET_CHANGED") {
        const response = await send();
        return { ...response, prepared };
      }
      throw error;
    }
  }

  async function deliver(pending: PendingMessage): Promise<void> {
    setSending(true);
    setSendError(null);
    try {
      const { message, prepared } = await postEncrypted(pending);
      if (prepared) {
        await commitSenderKeyMessage(prepared);
        await rememberHistoryKey({
          deviceId: identity.deviceId,
          messageId: message.id,
          messageKey: prepared.messageKey,
        });
      }
      prependMessage(queryClient, conversation.id, message);
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

  function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0] ?? null;
    setAttachmentError(null);
    if (!selected) {
      setAttachment(null);
      return;
    }
    if (selected.size === 0) {
      setAttachment(null);
      setAttachmentError("빈 파일은 첨부할 수 없습니다.");
      event.target.value = "";
      return;
    }
    if (selected.size > MAX_ATTACHMENT_BYTES) {
      setAttachment(null);
      setAttachmentError("파일은 5MB 이하만 첨부할 수 있습니다.");
      event.target.value = "";
      return;
    }
    setAttachment(selected);
  }

  function clearAttachment(): void {
    setAttachment(null);
    setAttachmentError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSubmit(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    const text = draft.trim();
    if ((!text && !attachment) || sending) return;

    setSending(true);
    setSendError(null);
    setAttachmentError(null);
    try {
      const clientMessageId = crypto.randomUUID();
      let plaintext = text;
      if (attachment) {
        // 파일은 1회용 키로 암호화하고, 키는 메시지 암호문 안에 넣어 전달한다.
        const encrypted = await encryptAttachment(attachment);
        const uploaded = await api<{ attachment: { id: string; size: number } }>(
          `/api/conversations/${conversation.id}/attachments`,
          {
            method: "POST",
            rawBody: new Blob([encrypted.ciphertext], {
              type: "application/octet-stream",
            }),
            headers: {
              "x-attachment-client-message-id": clientMessageId,
            },
          },
        );
        plaintext = encodeAttachmentPayload({
          id: uploaded.attachment.id,
          name: attachment.name,
          mime: attachment.type || "application/octet-stream",
          size: attachment.size,
          key: encrypted.key,
          iv: encrypted.iv,
          text,
        });
      }

      const pending: PendingMessage = {
        clientMessageId,
        plaintext,
      };
      pendingRef.current = pending;
      setDraft("");
      if (attachment) clearAttachment();
      await deliver(pending);
    } catch (error) {
      if (error instanceof AttachmentError) {
        setAttachmentError(error.message);
      } else if (error instanceof ApiError) {
        setSendError(
          error.code === "PAYLOAD_TOO_LARGE"
            ? "첨부 파일이 너무 큽니다."
            : error.message,
        );
      } else {
        setSendError("첨부 파일을 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.");
      }
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    void handleSubmit();
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
              peerDeleted ? "text-zinc-400" : "text-zinc-900",
            )}
          >
            {peerName}
          </h2>
          <p className="flex items-center gap-1.5 text-xs text-zinc-500">
            {typingNames.length > 0 ? (
              <span className="text-accent-600">
                {isGroup
                  ? `${typingNames.slice(0, 2).join(", ")}${
                      typingNames.length > 2 ? ` 외 ${typingNames.length - 2}명` : ""
                    } 입력 중…`
                  : "입력 중…"}
              </span>
            ) : peerDeleted ? (
              <span>계정 삭제됨</span>
            ) : isGroup ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-accent-400" />
                {conversation.memberCount}명
                {conversation.autoDeleteAfterReadSeconds !== null
                  ? ` · 읽은 뒤 ${autoDeleteLabel(conversation.autoDeleteAfterReadSeconds)} 삭제`
                  : ""}
              </>
            ) : (
              <>
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    peerOnline ? "bg-emerald-500" : "bg-zinc-300",
                  )}
                />
                {peerOnline ? "온라인" : "오프라인"}
                {conversation.autoDeleteAfterReadSeconds !== null
                  ? ` · 읽은 뒤 ${autoDeleteLabel(conversation.autoDeleteAfterReadSeconds)} 삭제`
                  : ""}
              </>
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => muteMutation.mutate(!conversation.muted)}
          aria-label={conversation.muted ? "대화 알림 켜기" : "대화 알림 끄기"}
          disabled={muteMutation.isPending}
        >
          {conversation.muted ? (
            <BellOff className="h-4 w-4" aria-hidden />
          ) : (
            <Bell className="h-4 w-4" aria-hidden />
          )}
          <span className="hidden sm:inline">
            {conversation.muted ? "알림 꺼짐" : "알림 켜짐"}
          </span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAutoDeleteOpen(true)}
          aria-label="자동 삭제 설정"
          title={
            conversation.autoDeleteAfterReadSeconds === null
              ? "자동 삭제 꺼짐"
              : `읽은 뒤 ${autoDeleteLabel(conversation.autoDeleteAfterReadSeconds)} 삭제`
          }
        >
          <Clock className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">자동 삭제</span>
        </Button>
        {isGroup ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSettingsOpen(true)}
            aria-label="그룹 설정"
          >
            <Settings className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">그룹 설정</span>
          </Button>
        ) : null}
        {isGroup && conversation.isAdmin ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMembersOpen(true)}
            aria-label="참여자 추가"
          >
            <UserPlus className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">참여자 추가</span>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSafetyOpen(true)}
          aria-label="안전번호"
          disabled={!safety}
        >
          <ShieldCheck className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">안전번호</span>
        </Button>
        {connection !== "open" ? (
          <span className="rounded-full bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
            연결 중…
          </span>
        ) : null}
      </header>

      {safetyChanged ? (
        <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          <span className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" aria-hidden />
            {isGroup
              ? "참여자의 기기 키가 변경되었습니다. 안전번호를 확인하세요."
              : "상대의 기기 키가 변경되었습니다. 안전번호를 확인하세요."}
          </span>
          <Button size="sm" variant="outline" onClick={acknowledgeSafetyChange}>
            확인
          </Button>
        </div>
      ) : null}

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
                      message.senderUserId === currentUserId
                        ? "나"
                        : (memberNames.get(message.senderUserId) ?? "알 수 없는 사용자")
                    }
                    readLabel={
                      message.senderUserId === currentUserId
                        ? readLabelFor(message)
                        : undefined
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

        {attachment || attachmentError ? (
          <div className="mb-2">
            {attachment ? (
              <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
                <Paperclip className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-800">
                  {attachment.name}
                </span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {formatBytes(attachment.size)}
                </span>
                <button
                  type="button"
                  onClick={clearAttachment}
                  aria-label="첨부 제거"
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : null}
            {attachmentError ? (
              <p className="mt-1 text-xs text-red-600">{attachmentError}</p>
            ) : null}
          </div>
        ) : null}

        {peerDeleted ? (
          <p className="py-2 text-center text-sm text-zinc-500">
            이 사용자는 계정을 삭제했습니다.
          </p>
        ) : (
          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              aria-label="파일 선택"
              onChange={handleAttachmentChange}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              aria-label="파일 첨부"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
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
              disabled={sending || (!draft.trim() && !attachment)}
              aria-label="전송"
            >
              {sending ? <Spinner /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        )}
        <p className="mt-1 text-[11px] text-zinc-400">
          Enter 전송 · Shift+Enter 줄바꿈
        </p>
      </form>

      <Dialog open={safetyOpen} onClose={() => setSafetyOpen(false)} title="안전번호">
        <p className="text-sm leading-relaxed text-zinc-600">
          {isGroup
            ? `그룹 참여자 ${conversation.memberCount}명의 기기 키로 만든 번호입니다. 참여자가 기기를 추가하거나 바꾸면 번호도 바뀝니다.`
            : `${peerName}님과 대면 또는 음성으로 아래 숫자를 대조하세요. 기기 키가 바뀌면 번호도 바뀝니다.`}
        </p>
        {safety ? (
          <div
            data-testid="safety-number"
            className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-zinc-50 p-3 font-mono text-sm text-zinc-800"
          >
            {safety.groups.map((group, index) => (
              <span key={`${group}-${index}`}>{group}</span>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">기기 정보를 불러오는 중…</p>
        )}
        <p className="mt-3 text-xs text-zinc-500">
          번호가 예상과 다르면 대화를 중단하고 상대에게 직접 확인하세요.
        </p>
      </Dialog>

      <AutoDeleteDialog
        open={autoDeleteOpen}
        onClose={() => setAutoDeleteOpen(false)}
        conversationId={conversation.id}
        initialSeconds={conversation.autoDeleteAfterReadSeconds}
        isGroup={isGroup}
        canEdit={!isGroup || conversation.isAdmin}
        onUpdated={() => {
          void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        }}
      />

      {isGroup ? (
        <GroupSettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          conversationId={conversation.id}
          currentName={conversation.name ?? "그룹"}
          canRename={conversation.isAdmin}
          onUpdated={() => {
            void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          }}
          onLeft={() => {
            void queryClient.invalidateQueries({ queryKey: ["conversations"] });
            setSettingsOpen(false);
            onLeft();
          }}
        />
      ) : null}

      {isGroup ? (
        <GroupMembersDialog
          open={membersOpen}
          onClose={() => setMembersOpen(false)}
          conversationId={conversation.id}
          existingMemberIds={[
            currentUserId,
            ...conversation.members.map((member) => member.id),
          ]}
          onAdded={() => {
            void queryClient.invalidateQueries({ queryKey: ["conversations"] });
            void queryClient.invalidateQueries({
              queryKey: ["conversation-devices", conversation.id],
            });
          }}
        />
      ) : null}
    </section>
  );
}
