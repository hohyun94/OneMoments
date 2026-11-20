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
  Pencil,
  Paperclip,
  Reply,
  Send,
  Settings,
  ShieldCheck,
  Trash2,
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
import { formatBytes, formatClock, formatDayLabel } from "../lib/format.ts";
import { autoDeleteLabel } from "../lib/autoDelete.ts";
import { removeIndexedMessages } from "../lib/search.ts";
import { useRealtime } from "../realtime.tsx";
import type {
  ActiveDevice,
  ConversationSummary,
  MessagePage,
  MessageView,
  ReactionSummary,
  ReadReceipt,
} from "../types.ts";
import { Alert, Avatar, Button, Dialog, Spinner, Textarea, cn } from "./ui.tsx";
import {
  MessageBubble,
  decryptMessageText,
  deleteDecryptedMessageCache,
} from "./MessageBubble.tsx";
import { GroupMembersDialog } from "./GroupMembersDialog.tsx";
import { GroupSettingsDialog } from "./GroupSettingsDialog.tsx";
import { AutoDeleteDialog } from "./AutoDeleteDialog.tsx";
import { computeSafetyNumber, type SafetyNumber } from "../lib/safety.ts";
import {
  ATTACHMENT_NAME_MAX,
  isTemporaryFileName,
  suggestedAttachmentName,
} from "../lib/attachmentName.ts";
import { recoveredAtFor } from "../lib/recovery.ts";

interface PendingMessage {
  clientMessageId: string;
  plaintext: string;
  kind?: "text" | "reaction" | "edit";
  targetMessageId?: string;
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

  const deleteMutation = useMutation({
    mutationFn: (input: { messageId: string; scope: "me" | "all" }) =>
      api<{ deletedMessageIds: string[]; scope: "me" | "all" }>(
        `/api/conversations/${conversation.id}/messages/${input.messageId}?scope=${input.scope}`,
        { method: "DELETE" },
      ),
    onSuccess: (response) => {
      const removed = new Set(response.deletedMessageIds);
      queryClient.setQueryData<InfiniteData<MessagePage>>(
        ["messages", conversation.id],
        (data) => {
          if (!data) return data;
          const pages = data.pages.map((page) => ({
            ...page,
            messages: page.messages.filter((message) => !removed.has(message.id)),
          }));
          return { ...data, pages };
        },
      );
      for (const id of removed) {
        deleteDecryptedMessageCache(id);
        void removeIndexedMessages([id]);
      }
      void queryClient.invalidateQueries({
        queryKey: ["messages", conversation.id],
      });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      setDeleteTarget(null);
      setSendError(null);
    },
    onError: (error) => {
      setSendError(
        error instanceof ApiError ? error.message : "메시지를 삭제하지 못했습니다.",
      );
    },
  });

  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentName, setAttachmentName] = useState("");
  const recoveredAt = recoveredAtFor(identity.deviceId);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [safety, setSafety] = useState<SafetyNumber | null>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [safetyChanged, setSafetyChanged] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoDeleteOpen, setAutoDeleteOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<{
    message: MessageView;
    text: string;
  } | null>(null);
  const [editing, setEditing] = useState<{ messageId: string; text: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MessageView | null>(null);
  const [reactionState, setReactionState] = useState<
    Map<string, { counts: Map<string, number>; mine: string | null }>
  >(new Map());
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
  const textMessages = useMemo(
    () => messages.filter((message) => message.kind === "text"),
    [messages],
  );
  const chronological = useMemo(() => [...textMessages].reverse(), [textMessages]);
  const latestId = textMessages[0]?.id;
  const editsByTarget = useMemo(() => {
    const edits = new Map<string, MessageView>();
    for (const message of messages) {
      if (message.kind !== "edit" || !message.targetMessageId) continue;
      const previous = edits.get(message.targetMessageId);
      if (
        !previous ||
        message.createdAt > previous.createdAt ||
        (message.createdAt === previous.createdAt && message.id > previous.id)
      ) {
        edits.set(message.targetMessageId, message);
      }
    }
    return edits;
  }, [messages]);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const reactionMessages = useMemo(
    () =>
      messages.filter(
        (message) => message.kind === "reaction" && message.targetMessageId !== null,
      ),
    [messages],
  );

  // 자동 삭제로 서버에서 사라진 메시지의 복호화 캐시도 함께 제거한다.
  const decryptedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    decryptedIdsRef.current = new Set();
  }, [conversation.id]);
  useEffect(() => {
    const current = new Set(chronological.map((message) => message.id));
    for (const id of decryptedIdsRef.current) {
      if (!current.has(id)) {
        deleteDecryptedMessageCache(id);
        void removeIndexedMessages([id]);
      }
    }
    decryptedIdsRef.current = current;
  }, [chronological]);

  useEffect(() => {
    let cancelled = false;
    const latest = new Map<string, MessageView>();
    for (const message of reactionMessages) {
      const key = `${message.targetMessageId ?? ""}:${message.senderUserId}`;
      const previous = latest.get(key);
      if (
        !previous ||
        message.createdAt > previous.createdAt ||
        (message.createdAt === previous.createdAt && message.id > previous.id)
      ) {
        latest.set(key, message);
      }
    }
    void Promise.all(
      [...latest.values()].map(async (message) => ({
        message,
        text: await decryptMessageText(identity, message),
      })),
    ).then((entries) => {
      if (cancelled) return;
      const next = new Map<
        string,
        { counts: Map<string, number>; mine: string | null }
      >();
      for (const entry of entries) {
        const { message, text } = entry;
        if (!message.targetMessageId || !text) continue;
        let payload: { emoji?: unknown; op?: unknown };
        try {
          payload = JSON.parse(text) as { emoji?: unknown; op?: unknown };
        } catch {
          continue;
        }
        const emoji = typeof payload.emoji === "string" ? payload.emoji.trim() : "";
        if (!emoji) continue;
        const aggregate = next.get(message.targetMessageId) ?? {
          counts: new Map<string, number>(),
          mine: null,
        };
        if (payload.op === "remove") {
          if (message.senderUserId === currentUserId) aggregate.mine = null;
        } else {
          aggregate.counts.set(emoji, (aggregate.counts.get(emoji) ?? 0) + 1);
          if (message.senderUserId === currentUserId) aggregate.mine = emoji;
        }
        next.set(message.targetMessageId, aggregate);
      }
      setReactionState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [identity, currentUserId, reactionMessages]);
  const typing = typingUsers(conversation.id);
  const isGroup = conversation.kind === "group";
  const otherReads = useMemo(
    () => (readsQuery.data ?? []).filter((read) => read.userId !== currentUserId),
    [readsQuery.data, currentUserId],
  );

  function readLabelFor(message: MessageView): string | undefined {
    if (!readsQuery.isSuccess) return undefined;
    const createdAt = Date.parse(message.createdAt);
    const readers = otherReads.filter(
      (read) => Date.parse(read.readAt) >= createdAt,
    );
    if (isGroup) {
      if (readers.length === 0) return "안 읽음";
      // 커서가 이 메시지에 걸린 참여자가 있으면 그 시각을 함께 보여준다.
      const cursorTimes = readers
        .filter((read) => read.lastReadMessageId === message.id)
        .map((read) => Date.parse(read.updatedAt));
      const latest = cursorTimes.length > 0 ? Math.max(...cursorTimes) : null;
      return latest
        ? `${readers.length}명 읽음 · ${formatClock(new Date(latest).toISOString())}`
        : `${readers.length}명 읽음`;
    }
    const [peerRead] = readers;
    if (!peerRead) return "안 읽음";
    return peerRead.lastReadMessageId === message.id
      ? `읽음 · ${formatClock(peerRead.updatedAt)}`
      : "읽음";
  }
  const peer = conversation.peer;
  const peerName = isGroup
    ? (conversation.name ?? "그룹")
    : (peer?.username ?? "삭제된 사용자");
  const peerDeleted = !isGroup && Boolean(peer?.deleted);
  const blocked = isGroup ? null : conversation.blocked;
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
    setReplyTarget(null);
    setEditing(null);
    setDeleteTarget(null);
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
          {
            method: "POST",
            body: {
              ...prepared.payload,
              kind: pending.kind ?? "text",
              ...(pending.targetMessageId
                ? { targetMessageId: pending.targetMessageId }
                : {}),
            },
          },
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
        {
          method: "POST",
          body: {
            ...payload,
            kind: pending.kind ?? "text",
            ...(pending.targetMessageId
              ? { targetMessageId: pending.targetMessageId }
              : {}),
          },
        },
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
      } else if (error instanceof ApiError && error.code === "USER_BLOCKED") {
        setSendError("차단된 대화입니다. 연락처에서 차단 상태를 확인하세요.");
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
      setAttachmentName("");
      return;
    }
    if (selected.size === 0) {
      setAttachment(null);
      setAttachmentName("");
      setAttachmentError("빈 파일은 첨부할 수 없습니다.");
      event.target.value = "";
      return;
    }
    if (selected.size > MAX_ATTACHMENT_BYTES) {
      setAttachment(null);
      setAttachmentName("");
      setAttachmentError("파일은 5MB 이하만 첨부할 수 있습니다.");
      event.target.value = "";
      return;
    }
    setAttachment(selected);
    // 브라우저가 원본 이름을 주지 못하면 날짜 기반 이름으로 채우고, 사용자가 수정할 수 있다.
    setAttachmentName(suggestedAttachmentName(selected));
  }

  function clearAttachment(): void {
    setAttachment(null);
    setAttachmentName("");
    setAttachmentError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSubmit(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    const text = draft.trim();
    if (sending) return;

    if (editing) {
      if (!text) return;
      setSending(true);
      setSendError(null);
      try {
        const pending: PendingMessage = {
          clientMessageId: crypto.randomUUID(),
          plaintext: text,
          kind: "edit",
          targetMessageId: editing.messageId,
        };
        pendingRef.current = pending;
        setDraft("");
        await deliver(pending);
        if (pendingRef.current === null) setEditing(null);
      } finally {
        setSending(false);
      }
      return;
    }

    if (!text && !attachment) return;

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
          name: (attachmentName.trim() || attachment.name).slice(0, ATTACHMENT_NAME_MAX),
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
        kind: "text",
        targetMessageId: replyTarget?.message.id,
      };
      pendingRef.current = pending;
      setDraft("");
      if (attachment) clearAttachment();
      await deliver(pending);
      if (pendingRef.current === null) setReplyTarget(null);
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

  async function reactTo(message: MessageView, emoji: string): Promise<void> {
    const current = reactionState.get(message.id)?.mine ?? null;
    const pending: PendingMessage = {
      clientMessageId: crypto.randomUUID(),
      plaintext: JSON.stringify({
        emoji,
        op: current === emoji ? "remove" : "add",
      }),
      kind: "reaction",
      targetMessageId: message.id,
    };
    pendingRef.current = pending;
    await deliver(pending);
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

  function senderLabel(userId: string): string {
    return userId === currentUserId
      ? "나"
      : (memberNames.get(userId) ?? "알 수 없는 사용자");
  }

  function reactionsFor(messageId: string): ReactionSummary[] {
    const entry = reactionState.get(messageId);
    if (!entry) return [];
    return [...entry.counts.entries()].map(([emoji, count]) => ({
      emoji,
      count,
      mine: entry.mine === emoji,
    }));
  }

  function replyTargetFor(message: MessageView): MessageView | null {
    if (!message.targetMessageId) return null;
    const target = messageById.get(message.targetMessageId);
    if (!target) return null;
    return editsByTarget.get(target.id) ?? target;
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
          <p className="flex items-center gap-1.5 truncate text-xs text-zinc-500">
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
                    blocked
                      ? "bg-amber-400"
                      : peerOnline
                        ? "bg-emerald-500"
                        : "bg-zinc-300",
                  )}
                />
                {blocked
                  ? blocked === "me"
                    ? "차단함"
                    : "차단됨"
                  : peerOnline
                    ? "온라인"
                    : "오프라인"}
                {peer?.statusMessage ? ` · ${peer.statusMessage}` : ""}
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

        {recoveredAt ? (
          <div className="pb-3">
            <Alert>
              <span className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  키 백업으로 복구된 기기입니다. 백업 시점(
                  {new Date(recoveredAt).toLocaleString("ko-KR")}) 이후 받은 메시지는 이
                  기기에서 읽을 수 없으므로, 다른 기기에서 확인하거나 상대에게 새 메시지를
                  받아야 합니다.
                </span>
              </span>
            </Alert>
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
                    senderName={senderLabel(message.senderUserId)}
                    readLabel={
                      message.senderUserId === currentUserId
                        ? readLabelFor(message)
                        : undefined
                    }
                    renderMessage={editsByTarget.get(message.id)}
                    edited={editsByTarget.has(message.id)}
                    replyTarget={replyTargetFor(message)}
                    replyTargetName={
                      replyTargetFor(message)
                        ? senderLabel(replyTargetFor(message)?.senderUserId ?? "")
                        : undefined
                    }
                    reactions={reactionsFor(message.id)}
                    onReact={(target, emoji) => void reactTo(target, emoji)}
                    onReply={(target, text) => {
                      setEditing(null);
                      setReplyTarget({ message: target, text });
                    }}
                    onEdit={(target, text) => {
                      setEditing({ messageId: target.id, text });
                      setDraft(text);
                      setReplyTarget(null);
                      clearAttachment();
                    }}
                    onDelete={(target) => setDeleteTarget(target)}
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

        {editing ? (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-accent-400/40 bg-accent-50 px-3 py-2">
            <Pencil className="mt-0.5 h-4 w-4 shrink-0 text-accent-700" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-medium text-accent-700">
                메시지 수정 중
              </span>
              <span className="block truncate text-xs text-zinc-600">{editing.text}</span>
            </span>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setDraft("");
              }}
              aria-label="수정 취소"
              className="rounded-md p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : replyTarget ? (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
            <Reply className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-medium text-zinc-600">
                {senderLabel(replyTarget.message.senderUserId)}에게 답장
              </span>
              <span className="block truncate text-xs text-zinc-500">
                {replyTarget.text || "첨부 메시지"}
              </span>
            </span>
            <button
              type="button"
              onClick={() => setReplyTarget(null)}
              aria-label="답장 취소"
              className="rounded-md p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}

        {attachment || attachmentError ? (
          <div className="mb-2">
            {attachment ? (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Paperclip className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
                  <input
                    value={attachmentName}
                    onChange={(event) => setAttachmentName(event.target.value)}
                    aria-label="파일 이름"
                    maxLength={ATTACHMENT_NAME_MAX}
                    className="min-w-0 flex-1 truncate bg-transparent text-sm text-zinc-800 focus:outline-none"
                  />
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
                {isTemporaryFileName(attachment.name) ? (
                  <p className="mt-1 text-[11px] text-zinc-500">
                    브라우저가 원본 파일명을 제공하지 않았습니다. 보낼 이름을 입력해 주세요.
                  </p>
                ) : null}
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
        ) : blocked ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-center text-sm leading-relaxed text-amber-900">
            {blocked === "me"
              ? "이 사용자를 차단했습니다. 연락처에서 차단을 해제하면 다시 메시지를 보낼 수 있습니다."
              : "차단된 대화입니다. 메시지를 보낼 수 없습니다."}
          </div>
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
              disabled={sending || editing !== null}
              aria-label="파일 첨부"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <Textarea
              id="message-input"
              rows={1}
              className="max-h-40 min-h-10"
              placeholder={
                editing ? "수정할 메시지" : replyTarget ? "답장 입력" : "메시지 입력"
              }
              value={draft}
              onChange={(event) => handleDraftChange(event.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="메시지 입력"
            />
            <Button
              type="submit"
              size="icon"
              disabled={
                sending ||
                (editing ? !draft.trim() : !draft.trim() && !attachment)
              }
              aria-label={editing ? "수정 저장" : "전송"}
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

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="메시지 삭제"
      >
        <p className="text-sm leading-relaxed text-zinc-600">
          {deleteTarget?.senderUserId === currentUserId
            ? "모두에게서 전송을 취소하면 대화 참여자 전원의 화면에서 사라지고, 반응·수정 기록·첨부 파일도 함께 삭제됩니다. 나에게만 삭제하면 내 화면과 내 다른 기기에서만 숨겨집니다."
            : "나에게만 삭제하면 내 화면과 내 다른 기기에서만 이 메시지가 숨겨집니다. 상대방의 화면에서는 그대로 유지됩니다."}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>
            취소
          </Button>
          <Button
            variant="ghost"
            disabled={deleteMutation.isPending}
            onClick={() => {
              if (deleteTarget) {
                deleteMutation.mutate({ messageId: deleteTarget.id, scope: "me" });
              }
            }}
          >
            {deleteMutation.isPending ? <Spinner /> : null}
            나에게만 삭제
          </Button>
          {deleteTarget?.senderUserId === currentUserId ? (
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) {
                  deleteMutation.mutate({ messageId: deleteTarget.id, scope: "all" });
                }
              }}
            >
              {deleteMutation.isPending ? <Spinner /> : <Trash2 className="h-4 w-4" />}
              모두에게서 전송 취소
            </Button>
          ) : null}
        </div>
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
