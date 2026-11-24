import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  Bell,
  BellOff,
  Clock,
  EyeOff,
  History,
  Link2,
  MapPin,
  Mic,
  Pencil,
  Paperclip,
  Phone,
  Pin,
  Reply,
  Send,
  Settings,
  ShieldCheck,
  Trash2,
  UserPlus,
  Video,
  X,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useSearchParams } from "react-router-dom";

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
import { formatBytes, formatClock, formatDayLabel, formatRelativeTime } from "../lib/format.ts";
import { applyMention, mentionQueryAtCursor } from "../lib/mentions.ts";
import {
  MAX_VOICE_SECONDS,
  formatDuration,
  pickVoiceMimeType,
  voiceFileName,
} from "../lib/voice.ts";
import { computeWaveform } from "../lib/waveform.ts";
import { autoDeleteLabel } from "../lib/autoDelete.ts";
import { removeIndexedMessages } from "../lib/search.ts";
import { describeReads, readersFor } from "../lib/readReceipts.ts";
import { isViewOnceLocked } from "../lib/viewOnce.ts";
import {
  encodeLinkMessage,
  extractFirstUrl,
  previewHost,
  type LinkPreviewMeta,
} from "../lib/linkPreviewMessage.ts";
import { uploadAttachment } from "../lib/upload.ts";
import { useRealtime } from "../realtime.tsx";
import { useCall } from "../calls.tsx";
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
import { CallHistoryDialog } from "./CallHistoryDialog.tsx";
import { GroupSettingsDialog } from "./GroupSettingsDialog.tsx";
import { AutoDeleteDialog } from "./AutoDeleteDialog.tsx";
import { computeSafetyNumber, type SafetyNumber } from "../lib/safety.ts";
import {
  ATTACHMENT_NAME_MAX,
  isTemporaryFileName,
  suggestedAttachmentName,
} from "../lib/attachmentName.ts";
import { recoveredAtFor } from "../lib/recovery.ts";
import {
  encodeLocationPayload,
  type LocationPayload,
} from "../lib/location.ts";
import { LocationShareDialog } from "./LocationShareDialog.tsx";

interface PendingMessage {
  clientMessageId: string;
  plaintext: string;
  kind?: "text" | "reaction" | "edit";
  targetMessageId?: string;
  /** 한 번 보기(수신자 열람 시 서버에서 삭제). */
  viewOnce?: boolean;
}

interface PendingAttachment {
  id: string;
  file: File;
  name: string;
  /** 음성 메시지 길이(초). */
  durationSeconds?: number;
  /** 음성 파형(0~100). 송신자가 녹음 직후 한 번 계산한다. */
  waveform?: number[];
}

/** 한 번에 첨부할 수 있는 파일 수(파일마다 별도 메시지로 전송). */
const MAX_ATTACHMENT_COUNT = 5;

/** 전송 중인 첨부(진행률·취소·재시도). */
interface UploadItem {
  id: string;
  name: string;
  size: number;
  file: File;
  durationSeconds?: number;
  waveform?: number[];
  /** 첫 파일에 붙일 캡션. 재시도해도 유지된다. */
  caption: string;
  phase: "encrypting" | "uploading" | "failed" | "cancelled";
  percent: number;
  error?: string;
  controller: AbortController | null;
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
  currentUsername,
  onBack,
  onLeft,
}: {
  conversation: ConversationSummary;
  identity: StoredIdentity;
  currentUserId: string;
  currentUsername: string;
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

  const pinnedQuery = useQuery({
    queryKey: ["pinned", conversation.id],
    queryFn: () =>
      api<MessagePage>(
        `/api/conversations/${conversation.id}/messages?limit=20&pinned=1`,
      ),
    refetchInterval: 30_000,
  });
  const pinnedMessages = useMemo(
    () => pinnedQuery.data?.messages ?? [],
    [pinnedQuery.data],
  );
  const [pinnedTexts, setPinnedTexts] = useState<Record<string, string>>({});

  // 고정 메시지는 배너에 미리보기로 보여준다(복호화 실패 시 자리표시).
  useEffect(() => {
    if (pinnedMessages.length === 0) {
      setPinnedTexts({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      pinnedMessages.slice(0, 5).map(async (message) => {
        try {
          return { id: message.id, text: await decryptMessageText(identity, message) };
        } catch {
          return { id: message.id, text: "" };
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const row of rows) {
        if (row.text) next[row.id] = row.text;
      }
      setPinnedTexts(next);
    });
    return () => {
      cancelled = true;
    };
  }, [identity, pinnedMessages]);

  const pinMutation = useMutation({
    mutationFn: (input: { messageId: string; pinned: boolean }) =>
      api(`/api/conversations/${conversation.id}/messages/${input.messageId}/pin`, {
        method: "PUT",
        body: { pinned: input.pinned },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pinned", conversation.id] });
      void queryClient.invalidateQueries({ queryKey: ["messages", conversation.id] });
    },
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
  /** 다음 전송을 한 번 보기로 보낼지. */
  const [viewOnce, setViewOnce] = useState(false);
  /** 수신자가 이번 세션에서 이미 연 한 번 보기 메시지(내용 표시용). */
  const [openedViewOnce, setOpenedViewOnce] = useState<Set<string>>(() => new Set());
  /** 첨부할 링크 미리보기(서버가 OG 메타데이터만 가져오고 저장하지 않는다). */
  const [linkPreview, setLinkPreview] = useState<LinkPreviewMeta | null>(null);
  const [linkPreviewBusy, setLinkPreviewBusy] = useState(false);
  const [linkPreviewError, setLinkPreviewError] = useState<string | null>(null);
  /** 진행 중/실패한 첨부 업로드(진행률·취소·재시도). */
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [recordingSeconds, setRecordingSeconds] = useState<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const recorderStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<number | undefined>(undefined);
  const recordingStartedAtRef = useRef(0);
  const voiceSupported =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined";
  const recoveredAt = recoveredAtFor(identity.deviceId);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [safety, setSafety] = useState<SafetyNumber | null>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
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
  const [callHistoryOpen, setCallHistoryOpen] = useState(false);
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

  const [searchParams, setSearchParams] = useSearchParams();
  const anchorId = searchParams.get("anchor");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const anchorAttemptsRef = useRef(0);

  // 검색 결과(?anchor=)로 넘어온 메시지로 스크롤한다. 아직 로드되지 않았으면 이전 메시지를 더 불러온다.
  useEffect(() => {
    if (!anchorId) {
      anchorAttemptsRef.current = 0;
      return;
    }
    const found = chronological.some((message) => message.id === anchorId);
    if (!found) {
      const canLoadMore =
        messagesQuery.hasNextPage &&
        !messagesQuery.isFetchingNextPage &&
        anchorAttemptsRef.current < 20;
      if (canLoadMore) {
        anchorAttemptsRef.current += 1;
        void messagesQuery.fetchNextPage();
      } else if (!messagesQuery.hasNextPage) {
        // 더 불러올 이력이 없으면 이동을 포기하고 파라미터를 정리한다.
        setSearchParams({}, { replace: true });
      }
      return;
    }
    document
      .getElementById(`message-${anchorId}`)
      ?.scrollIntoView({ block: "center" });
    setHighlightId(anchorId);
    setSearchParams({}, { replace: true });
  }, [
    anchorId,
    chronological,
    messagesQuery.hasNextPage,
    messagesQuery.isFetchingNextPage,
    messagesQuery.fetchNextPage,
    setSearchParams,
  ]);

  // 이동한 메시지는 잠시 강조한다.
  useEffect(() => {
    if (!highlightId) return;
    const timer = window.setTimeout(() => setHighlightId(null), 2_500);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  const firstUnreadId = useMemo(() => {
    if (conversation.unreadCount <= 0) return null;
    const mine = (readsQuery.data ?? []).find((read) => read.userId === currentUserId);
    if (!mine) return chronological[0]?.id ?? null;
    const index = chronological.findIndex(
      (message) => message.id === mine.lastReadMessageId,
    );
    if (index === -1) return null;
    return chronological[index + 1]?.id ?? null;
  }, [conversation.unreadCount, readsQuery.data, currentUserId, chronological]);

  function jumpToMessage(messageId: string): void {
    const node = document.getElementById(`message-${messageId}`);
    if (node) {
      node.scrollIntoView({ block: "center" });
      setHighlightId(messageId);
      return;
    }
    // 아직 로드되지 않은 이전 메시지면 앵커로 이동해 이어 불러온다.
    setSearchParams({ anchor: messageId }, { replace: true });
  }

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

  function readMetaFor(message: MessageView): { label: string; detail: string } | undefined {
    if (!readsQuery.isSuccess) return undefined;
    const readers = readersFor(otherReads, Date.parse(message.createdAt), currentUserId).map(
      (read) => ({
        label: senderLabel(read.userId),
        lastReadMessageId: read.lastReadMessageId,
        readAt: read.readAt,
        updatedAt: read.updatedAt,
      }),
    );
    return describeReads({ isGroup, readers, messageId: message.id, clock: formatClock });
  }
  const peer = conversation.peer;
  const peerName = isGroup
    ? (conversation.name ?? "그룹")
    : (peer?.username ?? "삭제된 사용자");
  const peerDeleted = !isGroup && Boolean(peer?.deleted);
  const blocked = isGroup ? null : conversation.blocked;
  const call = useCall();
  const canCall = !isGroup && call.enabled && Boolean(peer) && !peerDeleted && blocked === null;

  // 부재중 통화 배지: 대화를 열면 확인 처리하고 목록 배지를 지운다.
  useEffect(() => {
    if (conversation.missedCallCount <= 0) return;
    let cancelled = false;
    void api(`/api/conversations/${conversation.id}/calls/seen`, { method: "POST" })
      .then(() => {
        if (!cancelled) void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversation.id, conversation.missedCallCount, queryClient]);
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
  /** 멘션 강조·자동완성에 쓰는 참여자 username 목록(나 포함). */
  const mentionNames = useMemo(
    () => [...new Set([...memberNames.values(), currentUsername])],
    [memberNames, currentUsername],
  );
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null) return [];
    const query = mentionQuery.toLowerCase();
    return mentionNames
      .filter((name) => name.toLowerCase() !== currentUsername.toLowerCase())
      .filter((name) => name.toLowerCase().startsWith(query))
      .slice(0, 6);
  }, [mentionQuery, mentionNames, currentUsername]);
  const typingNames = typing
    .map((userId) => memberNames.get(userId))
    .filter((name): name is string => Boolean(name));
  const peerOnline =
    !isGroup && peer ? onlineUsers(conversation.id).includes(peer.id) : false;
  /** 본문에 URL 이 있으면 미리보기 버튼을 노출한다. */
  const draftUrl = extractFirstUrl(draft);

  // 본문에서 URL 이 사라지면 첨부해 둔 미리보기도 버린다.
  useEffect(() => {
    if (linkPreview && !draft.includes(linkPreview.url)) setLinkPreview(null);
  }, [draft, linkPreview]);

  useEffect(() => {
    setDraft("");
    setAttachments([]);
    setAttachmentError(null);
    setSendError(null);
    setReplyTarget(null);
    setEditing(null);
    setDeleteTarget(null);
    pendingRef.current = null;
    lastMarkedReadRef.current = null;
    cancelRecording();
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [conversation.id]);

  // 컴포넌트가 사라질 때도 마이크 스트림과 타이머를 정리한다.
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      recorderStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
    };
  }, []);

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
              ...(pending.viewOnce ? { viewOnce: true } : {}),
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
            ...(pending.viewOnce ? { viewOnce: true } : {}),
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

  /** 파일 선택·드래그&드롭·붙여넣기가 모두 이 경로로 들어온다(여러 파일 허용). */
  function addAttachmentFiles(files: File[]): void {
    if (files.length === 0) return;
    const accepted: PendingAttachment[] = [];
    let remaining = MAX_ATTACHMENT_COUNT - attachments.length;
    let error: string | null = null;

    for (const file of files) {
      if (remaining <= 0) {
        error = `첨부는 한 번에 ${MAX_ATTACHMENT_COUNT}개까지 가능합니다.`;
        break;
      }
      if (file.size === 0) {
        error = "빈 파일은 첨부할 수 없습니다.";
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        error = "파일은 5MB 이하만 첨부할 수 있습니다.";
        continue;
      }
      accepted.push({
        id: crypto.randomUUID(),
        file,
        // 브라우저가 원본 이름을 주지 못하면 날짜 기반 이름으로 채우고, 사용자가 수정할 수 있다.
        name: suggestedAttachmentName(file),
      });
      remaining -= 1;
    }

    setAttachmentError(error);
    if (accepted.length > 0) setAttachments((current) => [...current, ...accepted]);
  }

  function renameAttachment(id: string, name: string): void {
    setAttachments((current) =>
      current.map((item) => (item.id === id ? { ...item, name } : item)),
    );
  }

  function removeAttachment(id: string): void {
    setAttachments((current) => current.filter((item) => item.id !== id));
    setAttachmentError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>): void {
    addAttachmentFiles(Array.from(event.target.files ?? []));
    // 같은 파일을 다시 선택할 수 있도록 input 을 비운다.
    event.target.value = "";
  }

  function handleAttachmentDrop(event: DragEvent<HTMLDivElement>): void {
    if (sending || editing) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    addAttachmentFiles(files);
  }

  function handleAttachmentPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    addAttachmentFiles(files);
  }

  function clearAttachment(): void {
    setAttachments([]);
    setAttachmentError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function startRecording(): Promise<void> {
    if (recordingSeconds !== null) return;
    if (!voiceSupported) {
      setAttachmentError("이 브라우저는 음성 녹음을 지원하지 않습니다.");
      return;
    }
    setAttachmentError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickVoiceMimeType((type) => MediaRecorder.isTypeSupported(type));
      if (!mime) {
        stream.getTracks().forEach((track) => track.stop());
        setAttachmentError("지원되는 음성 녹음 형식이 없습니다.");
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorderChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recorderChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(recorderChunksRef.current, { type: mime });
        recorderChunksRef.current = [];
        stream.getTracks().forEach((track) => track.stop());
        recorderStreamRef.current = null;
        recorderRef.current = null;
        if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
        const seconds = Math.max(
          1,
          Math.round((Date.now() - recordingStartedAtRef.current) / 1000),
        );
        setRecordingSeconds(null);
        if (blob.size === 0) return;
        if (blob.size > MAX_ATTACHMENT_BYTES) {
          setAttachmentError("음성이 너무 큽니다. 5MB 이하만 보낼 수 있습니다.");
          return;
        }
        const name = voiceFileName(mime);
        const file = new File([blob], name, { type: mime, lastModified: Date.now() });
        // 파형은 송신자가 한 번만 계산해 암호문에 담는다(수신자는 그리기만 한다).
        const waveform = await computeWaveform(await blob.arrayBuffer());
        setAttachments((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            file,
            name,
            durationSeconds: seconds,
            ...(waveform ? { waveform } : {}),
          },
        ]);
      };
      recorderRef.current = recorder;
      recorderStreamRef.current = stream;
      recordingStartedAtRef.current = Date.now();
      setRecordingSeconds(0);
      recorder.start();
      recordingTimerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordingStartedAtRef.current) / 1000);
        setRecordingSeconds(elapsed);
        if (elapsed >= MAX_VOICE_SECONDS) {
          const active = recorderRef.current;
          if (active && active.state !== "inactive") active.stop();
        }
      }, 500);
    } catch {
      setAttachmentError("마이크 권한을 허용해야 음성을 보낼 수 있습니다.");
    }
  }

  function stopRecording(): void {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  function cancelRecording(): void {
    const recorder = recorderRef.current;
    recorderChunksRef.current = [];
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    recorderStreamRef.current?.getTracks().forEach((track) => track.stop());
    recorderStreamRef.current = null;
    recorderRef.current = null;
    if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
    setRecordingSeconds(null);
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

    if (!text && attachments.length === 0) return;

    setSending(true);
    setSendError(null);
    setAttachmentError(null);
    try {
      const targetMessageId = replyTarget?.message.id;

      if (attachments.length > 0) {
        // 첨부는 진행률·취소를 보여주기 위해 트레이로 옮겨 하나씩 암호화·업로드한다.
        const items: UploadItem[] = attachments.map((item) => ({
          id: crypto.randomUUID(),
          name: (item.name.trim() || item.file.name).slice(0, ATTACHMENT_NAME_MAX),
          size: item.file.size,
          file: item.file,
          ...(item.durationSeconds !== undefined
            ? { durationSeconds: item.durationSeconds }
            : {}),
          ...(item.waveform ? { waveform: item.waveform } : {}),
          caption: text,
          phase: "encrypting" as const,
          percent: 0,
          controller: null,
        }));
        setUploads((current) => [...current, ...items]);
        setAttachments([]);
        setDraft("");

        const queue: PendingMessage[] = [];
        let captionUsed = false;
        for (const item of items) {
          const pending = await uploadOne(item, !captionUsed, targetMessageId);
          if (!pending) continue;
          captionUsed = true;
          queue.push(pending);
        }
        // 성공한 항목은 트레이에서 제거하고 실패/취소 항목만 남긴다.
        setUploads((current) =>
          current.filter((upload) => upload.phase === "failed" || upload.phase === "cancelled"),
        );
        for (const pending of queue) {
          pendingRef.current = pending;
          await deliver(pending);
        }
        if (pendingRef.current === null) setReplyTarget(null);
        return;
      }

      const pending: PendingMessage = {
        clientMessageId: crypto.randomUUID(),
        plaintext:
          linkPreview !== null ? encodeLinkMessage({ text, preview: linkPreview }) : text,
        kind: "text",
        viewOnce,
        targetMessageId,
      };
      setDraft("");
      pendingRef.current = pending;
      await deliver(pending);
      setViewOnce(false);
      setLinkPreview(null);
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

  /** 파일 하나를 암호화·업로드해 메시지 페이로드를 만든다(진행률·취소 지원). */
  async function uploadOne(
    item: UploadItem,
    asFirst: boolean,
    targetMessageId: string | undefined,
  ): Promise<PendingMessage | null> {
    const controller = new AbortController();
    setUploads((current) =>
      current.map((upload) =>
        upload.id === item.id
          ? { ...upload, phase: "encrypting", percent: 0, error: undefined, controller }
          : upload,
      ),
    );
    try {
      const encrypted = await encryptAttachment(item.file);
      if (controller.signal.aborted) {
        setUploads((current) =>
          current.map((upload) =>
            upload.id === item.id
              ? { ...upload, phase: "cancelled", controller: null }
              : upload,
          ),
        );
        return null;
      }
      setUploads((current) =>
        current.map((upload) =>
          upload.id === item.id ? { ...upload, phase: "uploading" } : upload,
        ),
      );
      const uploaded = await uploadAttachment({
        conversationId: conversation.id,
        clientMessageId: item.id,
        body: new Blob([encrypted.ciphertext], { type: "application/octet-stream" }),
        signal: controller.signal,
        onProgress: (progress) => {
          setUploads((current) =>
            current.map((upload) =>
              upload.id === item.id ? { ...upload, percent: progress.percent } : upload,
            ),
          );
        },
      });
      return {
        clientMessageId: item.id,
        plaintext: encodeAttachmentPayload({
          id: uploaded.attachment.id,
          name: item.name,
          mime: item.file.type || "application/octet-stream",
          size: item.size,
          key: encrypted.key,
          iv: encrypted.iv,
          text: asFirst ? item.caption : "",
          ...(item.durationSeconds !== undefined
            ? { durationSeconds: item.durationSeconds }
            : {}),
          ...(item.waveform ? { waveform: item.waveform } : {}),
        }),
        kind: "text",
        viewOnce: asFirst ? viewOnce : false,
        targetMessageId: asFirst ? targetMessageId : undefined,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setUploads((current) =>
          current.map((upload) =>
            upload.id === item.id
              ? { ...upload, phase: "cancelled", controller: null }
              : upload,
          ),
        );
        return null;
      }
      const message =
        error instanceof AttachmentError
          ? error.message
          : error instanceof ApiError
            ? error.message
            : "첨부 파일을 보낼 수 없습니다.";
      setUploads((current) =>
        current.map((upload) =>
          upload.id === item.id
            ? { ...upload, phase: "failed", error: message, controller: null }
            : upload,
        ),
      );
      return null;
    }
  }

  function cancelUpload(id: string): void {
    setUploads((current) =>
      current.map((upload) => {
        if (upload.id !== id) return upload;
        upload.controller?.abort();
        return { ...upload, controller: null };
      }),
    );
  }

  function removeUpload(id: string): void {
    setUploads((current) => current.filter((upload) => upload.id !== id));
  }

  async function retryUpload(item: UploadItem): Promise<void> {
    if (sending) return;
    setSending(true);
    setSendError(null);
    try {
      const pending = await uploadOne(item, true, replyTarget?.message.id);
      if (!pending) return;
      setUploads((current) => current.filter((upload) => upload.id !== item.id));
      pendingRef.current = pending;
      await deliver(pending);
    } finally {
      setSending(false);
    }
  }

  /** 링크 미리보기를 서버에서 가져온다(공개 메타데이터, 서버 저장 없음). */
  async function loadLinkPreview(url: string): Promise<void> {
    if (linkPreviewBusy) return;
    setLinkPreviewBusy(true);
    setLinkPreviewError(null);
    try {
      const response = await api<{ preview: LinkPreviewMeta | null }>(
        `/api/link-preview?url=${encodeURIComponent(url)}`,
      );
      if (response.preview) {
        setLinkPreview(response.preview);
      } else {
        setLinkPreviewError("미리보기를 가져올 수 없습니다.");
      }
    } catch {
      setLinkPreviewError("미리보기를 가져올 수 없습니다.");
    } finally {
      setLinkPreviewBusy(false);
    }
  }

  /** 다른 참여자가 보낸 한 번 보기 메시지를 연다(열람 알림 → 서버가 삭제). */
  async function openViewOnce(target: MessageView): Promise<void> {
    setOpenedViewOnce((previous) => {
      const next = new Set(previous);
      next.add(target.id);
      return next;
    });
    try {
      await api(`/api/conversations/${conversation.id}/messages/${target.id}/viewed`, {
        method: "POST",
      });
    } catch {
      // 삭제 알림은 서버/WS 가 처리한다. 실패해도 이미 열어 본 내용은 유지한다.
    }
  }

  /** 위치 공유도 일반 텍스트 메시지와 같은 경로로 보낸다(본문이 암호화됨). */
  async function sendLocation(location: LocationPayload): Promise<void> {
    const pending: PendingMessage = {
      clientMessageId: crypto.randomUUID(),
      plaintext: encodeLocationPayload(location),
      kind: "text",
      targetMessageId: replyTarget?.message.id,
    };
    pendingRef.current = pending;
    await deliver(pending);
    if (pendingRef.current === null) {
      setLocationOpen(false);
      setReplyTarget(null);
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

  function handleDraftChange(value: string, cursor?: number | null) {
    setDraft(value);
    const at = mentionQueryAtCursor(value, cursor ?? value.length);
    setMentionQuery(at ? at.query : null);
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

  function insertMention(username: string): void {
    const textarea = draftRef.current;
    const cursor = textarea?.selectionStart ?? draft.length;
    const next = applyMention(draft, cursor, username);
    setDraft(next.text);
    setMentionQuery(null);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  // 서식 버튼(B/코드)은 메신저 사용 빈도가 낮아 툴바에서 제거했다. 마크다운 직접 입력은 그대로 지원한다.

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
        <Avatar name={peerName} userId={peer?.id} avatarUpdatedAt={peer?.avatarUpdatedAt} />
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
                    : peer?.lastSeenAt
                      ? `마지막 접속 ${formatRelativeTime(peer.lastSeenAt)}`
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
        {canCall ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void call.startCall({
                conversationId: conversation.id,
                peerUserId: peer?.id ?? "",
                peerLabel: peer?.username ? `@${peer.username}` : "상대",
              })
            }
            aria-label="음성 통화"
            title="음성 통화"
          >
            <Phone className="h-4 w-4" aria-hidden />
          </Button>
        ) : null}
        {canCall && call.videoEnabled ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void call.startCall({
                conversationId: conversation.id,
                peerUserId: peer?.id ?? "",
                peerLabel: peer?.username ? `@${peer.username}` : "상대",
                media: "video",
              })
            }
            aria-label="영상 통화"
            title="영상 통화"
          >
            <Video className="h-4 w-4" aria-hidden />
          </Button>
        ) : null}
        {!isGroup ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCallHistoryOpen(true)}
            aria-label="통화 기록"
            title="통화 기록"
          >
            <History className="h-4 w-4" aria-hidden />
          </Button>
        ) : null}
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

      <div
        className="flex-1 overflow-y-auto px-3 py-4 md:px-6"
        aria-live="polite"
        onDragOver={(event) => {
          if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
        }}
        onDrop={handleAttachmentDrop}
      >
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

        {pinnedMessages.length > 0 ? (
          <div className="mb-3 rounded-lg border border-accent-200 bg-accent-50/60 px-3 py-2">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-accent-700">
              <Pin className="h-3.5 w-3.5" aria-hidden />
              고정된 메시지 {pinnedMessages.length}
            </p>
            <ul className="mt-1 space-y-0.5">
              {pinnedMessages.slice(0, 3).map((message) => (
                <li key={message.id}>
                  <button
                    type="button"
                    onClick={() => jumpToMessage(message.id)}
                    className="w-full truncate text-left text-xs text-zinc-700 hover:underline"
                  >
                    {pinnedTexts[message.id] ?? "고정된 메시지"}
                  </button>
                </li>
              ))}
            </ul>
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
                  <Fragment key={message.id}>
                    {message.id === firstUnreadId ? (
                      <div className="flex items-center gap-3 py-1 text-[11px] font-medium text-accent-600">
                        <span className="h-px flex-1 bg-accent-200" />
                        여기부터 새 메시지
                        <span className="h-px flex-1 bg-accent-200" />
                      </div>
                    ) : null}
                    <div
                      id={`message-${message.id}`}
                      className={cn(
                        "scroll-mt-24 rounded-2xl transition-shadow",
                        highlightId === message.id &&
                          "ring-2 ring-accent-400 ring-offset-2",
                      )}
                    >
                      <MessageBubble
                        message={message}
                        identity={identity}
                        own={message.senderUserId === currentUserId}
                        senderName={senderLabel(message.senderUserId)}
                        readLabel={
                          message.senderUserId === currentUserId
                            ? readMetaFor(message)?.label
                            : undefined
                        }
                        readDetail={
                          message.senderUserId === currentUserId
                            ? readMetaFor(message)?.detail
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
                        pinned={message.pinned}
                        onTogglePin={(target) =>
                          pinMutation.mutate({
                            messageId: target.id,
                            pinned: !target.pinned,
                          })
                        }
                        viewOnceLocked={isViewOnceLocked({
                          viewOnce: message.viewOnce,
                          own: message.senderUserId === currentUserId,
                          opened: openedViewOnce.has(message.id),
                        })}
                        onOpenViewOnce={(target) => void openViewOnce(target)}
                        mentionNames={mentionNames}
                        mentionUser={currentUsername}
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
                    </div>
                  </Fragment>
                ))}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {firstUnreadId ? (
        <div className="flex justify-center bg-white pb-1">
          <Button variant="outline" size="sm" onClick={() => jumpToMessage(firstUnreadId)}>
            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
            새 메시지부터 보기
          </Button>
        </div>
      ) : null}

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

        {recordingSeconds !== null ? (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
            <span className="flex items-center gap-1.5 text-sm font-medium text-red-700">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" aria-hidden />
              녹음 중 {formatDuration(recordingSeconds)}
            </span>
            <span className="text-[11px] text-red-600">
              최대 {formatDuration(MAX_VOICE_SECONDS)}
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Button type="button" size="sm" variant="outline" onClick={cancelRecording}>
                취소
              </Button>
              <Button type="button" size="sm" onClick={stopRecording}>
                완료
              </Button>
            </span>
          </div>
        ) : null}

        {attachments.length > 0 || attachmentError ? (
          <div className="mb-2 space-y-1">
            {attachments.map((item, index) => (
              <div
                key={item.id}
                className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <Paperclip className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
                  <input
                    value={item.name}
                    onChange={(event) => renameAttachment(item.id, event.target.value)}
                    aria-label={
                      attachments.length > 1 ? `파일 이름 ${index + 1}` : "파일 이름"
                    }
                    maxLength={ATTACHMENT_NAME_MAX}
                    className="min-w-0 flex-1 truncate bg-transparent text-sm text-zinc-800 focus:outline-none"
                  />
                  <span className="shrink-0 text-xs text-zinc-500">
                    {formatBytes(item.file.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(item.id)}
                    aria-label={`첨부 제거 ${index + 1}`}
                    className="rounded-md p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {isTemporaryFileName(item.file.name) ? (
                  <p className="mt-1 text-[11px] text-zinc-500">
                    브라우저가 원본 파일명을 제공하지 않았습니다. 보낼 이름을 입력해 주세요.
                  </p>
                ) : null}
              </div>
            ))}
            {attachments.length > 1 ? (
              <p className="text-[11px] text-zinc-500">
                첨부 {attachments.length}개 · 파일마다 별도 메시지로 전송됩니다.
              </p>
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
          <>
            {mentionOptions.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-1 rounded-lg border border-zinc-200 bg-white p-1.5 shadow-sm">
                {mentionOptions.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => insertMention(name)}
                    className="rounded-md px-2 py-1 text-xs font-medium text-accent-700 hover:bg-accent-50"
                  >
                    @{name}
                  </button>
                ))}
              </div>
            ) : null}
            {uploads.length > 0 ? (
              <div className="mb-2 space-y-1.5" data-testid="upload-tray">
                {uploads.map((upload) => (
                  <div
                    key={upload.id}
                    className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-[11px]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-zinc-700">{upload.name}</p>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded bg-zinc-200">
                        <div
                          className={cn(
                            "h-full transition-all",
                            upload.phase === "failed" ? "bg-rose-500" : "bg-accent-600",
                          )}
                          style={{ width: `${upload.percent}%` }}
                        />
                      </div>
                      <p
                        data-testid="upload-status"
                        className={cn(
                          "mt-0.5 truncate",
                          upload.phase === "failed" ? "text-rose-600" : "text-zinc-400",
                        )}
                      >
                        {upload.phase === "encrypting"
                          ? "암호화 중…"
                          : upload.phase === "uploading"
                            ? `전송 중 ${upload.percent}%`
                            : upload.phase === "failed"
                              ? (upload.error ?? "전송 실패")
                              : "취소됨"}
                      </p>
                    </div>
                    {upload.phase === "failed" || upload.phase === "cancelled" ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void retryUpload(upload)}
                          disabled={sending}
                        >
                          다시 시도
                        </Button>
                        <button
                          type="button"
                          onClick={() => removeUpload(upload.id)}
                          aria-label="목록에서 제거"
                          className="text-zinc-400 hover:text-zinc-600"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => cancelUpload(upload.id)}
                      >
                        취소
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
            {viewOnce ? (
              <p className="mb-1.5 flex items-center gap-1.5 rounded-lg bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                <EyeOff className="h-3 w-3" aria-hidden />
                한 번 보기: 상대가 열면 양쪽에서 삭제됩니다.
              </p>
            ) : null}
            {draftUrl && !linkPreview && attachments.length === 0 ? (
              <button
                type="button"
                onClick={() => void loadLinkPreview(draftUrl)}
                disabled={linkPreviewBusy}
                className="mb-1.5 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
              >
                <Link2 className="h-3 w-3" aria-hidden />
                {linkPreviewBusy ? "미리보기 불러오는 중…" : "링크 미리보기"}
              </button>
            ) : null}
            {linkPreview ? (
              <div className="mb-1.5 flex items-start gap-2 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-[11px]">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-zinc-800">
                    {linkPreview.title ?? linkPreview.url}
                  </p>
                  <p className="truncate text-zinc-400">
                    {linkPreview.siteName ?? previewHost(linkPreview.url)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setLinkPreview(null)}
                  aria-label="링크 미리보기 제거"
                  className="text-zinc-400 hover:text-zinc-600"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            ) : null}
            {linkPreviewError ? (
              <p className="mb-1.5 text-[11px] text-rose-600">{linkPreviewError}</p>
            ) : null}
            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                aria-label="파일 선택"
                onChange={handleAttachmentChange}
              />
              {voiceSupported ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => void startRecording()}
                  disabled={sending || editing !== null || recordingSeconds !== null}
                  aria-label="음성 녹음"
                  title="음성 메시지 녹음 (최대 5분)"
                >
                  <Mic className="h-4 w-4" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setLocationOpen(true)}
                disabled={sending || editing !== null || recordingSeconds !== null}
                aria-label="위치 공유"
                title="현재 위치 보내기"
              >
                <MapPin className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant={viewOnce ? "default" : "ghost"}
                size="icon"
                onClick={() => setViewOnce((value) => !value)}
                disabled={sending || editing !== null || recordingSeconds !== null}
                aria-label="한 번 보기"
                aria-pressed={viewOnce}
                title={viewOnce ? "한 번 보기 끄기" : "한 번 보기(상대가 열면 양쪽에서 삭제)"}
              >
                <EyeOff className="h-4 w-4" />
              </Button>
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
                ref={draftRef}
                id="message-input"
                rows={1}
                className="max-h-40 min-h-10"
                placeholder={
                  editing ? "수정할 메시지" : replyTarget ? "답장 입력" : "메시지 입력"
                }
                value={draft}
                onChange={(event) =>
                  handleDraftChange(event.target.value, event.target.selectionStart)
                }
                onPaste={handleAttachmentPaste}
                onKeyDown={handleKeyDown}
                aria-label="메시지 입력"
              />
              <Button
                type="submit"
                size="icon"
                disabled={
                  sending ||
                  (editing ? !draft.trim() : !draft.trim() && attachments.length === 0)
                }
                aria-label={editing ? "수정 저장" : "전송"}
              >
                {sending ? <Spinner /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </>
        )}
        <p className="mt-1 text-[11px] text-zinc-400">
          Enter 전송 · Shift+Enter 줄바꿈
        </p>
      </form>

      <LocationShareDialog
        open={locationOpen}
        onClose={() => setLocationOpen(false)}
        onSend={(location) => void sendLocation(location)}
        sending={sending}
      />

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

      {!isGroup ? (
        <CallHistoryDialog
          open={callHistoryOpen}
          onClose={() => setCallHistoryOpen(false)}
          conversationId={conversation.id}
        />
      ) : null}

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
