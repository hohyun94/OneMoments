import { BellOff, LogOut, MessageSquarePlus, ShieldCheck, Smartphone, Users } from "lucide-react";

import { formatListTime } from "../lib/format.ts";
import type { RealtimeStatus } from "../realtime.tsx";
import type { ConversationSummary } from "../types.ts";
import { Avatar, Button, cn } from "./ui.tsx";

export function ConversationSidebar({
  conversations,
  selectedId,
  displayName,
  connection,
  onSelect,
  onNewConversation,
  onOpenDevices,
  onLogout,
}: {
  conversations: ConversationSummary[];
  selectedId: string | null;
  displayName: string;
  connection: RealtimeStatus;
  onSelect: (conversationId: string) => void;
  onNewConversation: () => void;
  onOpenDevices: () => void;
  onLogout: () => void;
}) {
  return (
    <aside className="flex h-full w-full flex-col border-r border-zinc-200 bg-white md:w-80 md:shrink-0">
      <header className="border-b border-zinc-100 px-4 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium tracking-wide text-violet-600">OneMoments</p>
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

      <nav className="flex-1 overflow-y-auto px-2 py-2" aria-label="대화 목록">
        {conversations.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm leading-relaxed text-zinc-500">
            아직 대화가 없습니다.
            <br />
            사용자 아이디로 새 대화를 시작하세요.
          </div>
        ) : (
          <ul className="space-y-1">
            {conversations.map((conversation) => {
              const isGroup = conversation.kind === "group";
              const name = isGroup
                ? (conversation.name ?? "그룹")
                : (conversation.peer?.username ?? "삭제된 사용자");
              const deleted = !isGroup && Boolean(conversation.peer?.deleted);
              const active = conversation.id === selectedId;
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(conversation.id)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                      active ? "bg-violet-50" : "hover:bg-zinc-50",
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
                        <span className="shrink-0 text-[11px] text-zinc-400">
                          {formatListTime(conversation.lastMessageAt)}
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
                        {isGroup
                          ? `${conversation.memberCount}명 · 종단간 암호화`
                          : "종단간 암호화"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <footer className="border-t border-zinc-100 p-2">
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
