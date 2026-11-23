import {
  BellOff,
  Contact,
  LogOut,
  MessageSquarePlus,
  PhoneMissed,
  Pin,
  Search,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Star,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { sortPinnedFirst } from "../lib/conversationPins.ts";
import { formatListTime } from "../lib/format.ts";
import { searchMessages, type SearchableMessage } from "../lib/search.ts";
import type { RealtimeStatus } from "../realtime.tsx";
import type { ConversationSummary } from "../types.ts";
import { Avatar, Button, cn } from "./ui.tsx";

export function ConversationSidebar({
  conversations,
  selectedId,
  displayName,
  connection,
  isAdmin,
  onSelect,
  onSelectMessage,
  pinnedIds,
  onTogglePinConversation,
  onNewConversation,
  onOpenMoments,
  onOpenContacts,
  onOpenDevices,
  onOpenAdmin,
  onLogout,
}: {
  conversations: ConversationSummary[];
  selectedId: string | null;
  displayName: string;
  connection: RealtimeStatus;
  isAdmin: boolean;
  onSelect: (conversationId: string) => void;
  onSelectMessage: (conversationId: string, messageId: string) => void;
  pinnedIds: string[];
  onTogglePinConversation: (conversationId: string) => void;
  onNewConversation: () => void;
  onOpenMoments: () => void;
  onOpenContacts: () => void;
  onOpenDevices: () => void;
  onOpenAdmin: () => void;
  onLogout: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchableMessage[]>([]);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchMessages(text, { limit: 30 }).then((rows) => {
        if (!cancelled) setResults(rows);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  function conversationLabel(conversationId: string): string {
    const conversation = conversations.find((item) => item.id === conversationId);
    if (!conversation) return "대화";
    return conversation.kind === "group"
      ? (conversation.name ?? "그룹")
      : (conversation.peer?.username ?? "삭제된 사용자");
  }

  return (
    <aside className="flex h-full w-full flex-col border-r border-zinc-200 bg-white md:w-80 md:shrink-0">
      <header className="border-b border-zinc-100 px-4 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium tracking-wide text-accent-600">OneMoments</p>
            <p className="text-lg font-semibold text-zinc-900">@{displayName}</p>
          </div>
          <span
            title={connection === "open" ? "실시간 연결됨" : "실시간 연결 중"}
            className={cn(
              "h-2.5 w-2.5 rounded-full",
              connection === "open"
                ? "bg-emerald-500"
                : connection === "connecting"
                  ? "bg-amber-400"
                  : "bg-zinc-300",
            )}
          />
        </div>
        <Button className="mt-4 w-full" onClick={onNewConversation}>
          <MessageSquarePlus className="h-4 w-4" aria-hidden />새 대화
        </Button>
      </header>

      <div className="border-b border-zinc-100 px-3 py-2">
        <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2">
          <Search className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="메시지 검색 (2자 이상)"
            aria-label="메시지 검색"
            className="h-8 min-w-0 flex-1 bg-transparent text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="검색 지우기"
              className="rounded-md p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        {query.trim().length >= 2 ? (
          <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-zinc-200 bg-white">
            {results.length === 0 ? (
              <p className="px-3 py-3 text-xs leading-relaxed text-zinc-500">
                검색 결과가 없습니다. 이 기기에서 복호화된 메시지만 검색합니다.
              </p>
            ) : (
              results.map((result) => (
                <button
                  key={result.id}
                  type="button"
                  onClick={() => {
                    onSelectMessage(result.conversationId, result.id);
                    setQuery("");
                    setResults([]);
                  }}
                  className="block w-full border-b border-zinc-100 px-3 py-2 text-left last:border-0 hover:bg-zinc-50"
                >
                  <span className="block text-[11px] font-medium text-zinc-600">
                    {conversationLabel(result.conversationId)}
                  </span>
                  <span className="line-clamp-2 break-words text-xs text-zinc-500">
                    {result.text}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2" aria-label="대화 목록">
        {conversations.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm leading-relaxed text-zinc-500">
            아직 대화가 없습니다.
            <br />
            사용자 아이디로 새 대화를 시작하세요.
          </div>
        ) : (
          <ul className="space-y-1">
            {sortPinnedFirst(conversations, pinnedIds).map((conversation) => {
              const isGroup = conversation.kind === "group";
              const name = isGroup
                ? (conversation.name ?? "그룹")
                : (conversation.peer?.username ?? "삭제된 사용자");
              const deleted = !isGroup && Boolean(conversation.peer?.deleted);
              const active = conversation.id === selectedId;
              const unread = conversation.unreadCount;
              const missedCalls = conversation.missedCallCount ?? 0;
              const pinned = pinnedIds.includes(conversation.id);
              return (
                <li key={conversation.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onSelect(conversation.id)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                      active ? "bg-accent-50" : "hover:bg-zinc-50",
                    )}
                  >
                    <Avatar name={name} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span
                          className={cn(
                            "truncate text-sm font-medium",
                            deleted ? "text-zinc-400" : "text-zinc-900",
                          )}
                        >
                          {name}
                        </span>
                        {pinned ? (
                          <Pin
                            className="h-3 w-3 shrink-0 fill-current text-accent-600"
                            aria-label="고정된 대화"
                          />
                        ) : null}
                        {conversation.favorite ? (
                          <Star
                            className="h-3 w-3 shrink-0 fill-amber-400 text-amber-500"
                            aria-label="즐겨찾기"
                          />
                        ) : null}
                        <span className="flex shrink-0 items-center gap-1.5">
                          {missedCalls > 0 ? (
                            <span
                              aria-label={`부재중 전화 ${missedCalls}건`}
                              title={`부재중 전화 ${missedCalls}건`}
                              className="flex h-5 items-center gap-0.5 rounded-full bg-red-600 px-1.5 text-[10px] font-semibold text-white"
                            >
                              <PhoneMissed className="h-3 w-3" aria-hidden />
                              {missedCalls > 99 ? "99+" : missedCalls}
                            </span>
                          ) : null}
                          {unread > 0 && !active ? (
                            <span
                              aria-label={`읽지 않은 메시지 ${unread}개`}
                              className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-600 px-1.5 text-[10px] font-semibold text-accent-contrast"
                            >
                              {unread > 99 ? "99+" : unread}
                            </span>
                          ) : null}
                          <span className="text-[11px] text-zinc-400">
                            {formatListTime(conversation.lastMessageAt)}
                          </span>
                        </span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500">
                        {conversation.muted ? (
                          <span title="알림 꺼짐">
                            <BellOff className="h-3 w-3" aria-hidden />
                          </span>
                        ) : null}
                        {isGroup ? (
                          <Users className="h-3 w-3" aria-hidden />
                        ) : (
                          <ShieldCheck className="h-3 w-3" aria-hidden />
                        )}
                        {isGroup ? `${conversation.memberCount}명` : "1:1 대화"}
                        {!isGroup && conversation.blocked
                          ? ` · ${conversation.blocked === "me" ? "차단함" : "차단됨"}`
                          : ""}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onTogglePinConversation(conversation.id)}
                    aria-label={pinned ? "대화 고정 해제" : "대화 고정"}
                    title={pinned ? "고정 해제" : "고정"}
                    className={cn(
                      "mr-1 shrink-0 rounded-md p-1 hover:bg-zinc-100",
                      pinned ? "text-accent-600" : "text-zinc-300 hover:text-zinc-600",
                    )}
                  >
                    <Pin className={cn("h-3.5 w-3.5", pinned && "fill-current")} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <footer className="border-t border-zinc-100 p-2">
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={onOpenContacts}
        >
          <Contact className="h-4 w-4" aria-hidden />
          연락처
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={onOpenMoments}
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          Moments
        </Button>
        {isAdmin ? (
          <Button variant="ghost" className="w-full justify-start" onClick={onOpenAdmin}>
            <ShieldAlert className="h-4 w-4" aria-hidden />
            관리자 콘솔
          </Button>
        ) : null}
        <Button variant="ghost" className="w-full justify-start" onClick={onOpenDevices}>
          <Smartphone className="h-4 w-4" aria-hidden />
          기기 관리
        </Button>
        <Button variant="ghost" className="w-full justify-start" onClick={onLogout}>
          <LogOut className="h-4 w-4" aria-hidden />
          로그아웃
        </Button>
      </footer>
    </aside>
  );
}
