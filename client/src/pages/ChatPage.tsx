import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { ChatView } from "../components/ChatView.tsx";
import { ConversationSidebar } from "../components/ConversationSidebar.tsx";
import { NewConversationDialog } from "../components/NewConversationDialog.tsx";
import { Button, Spinner, cn } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { RealtimeProvider, useRealtime } from "../realtime.tsx";
import { useSession } from "../session.tsx";
import type { ConversationSummary } from "../types.ts";

export function ChatPage() {
  const { session, identity, logout } = useSession();
  const navigate = useNavigate();
  const { conversationId } = useParams();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);

  const conversationsQuery = useQuery({
    queryKey: ["conversations"],
    queryFn: () =>
      api<{ conversations: ConversationSummary[] }>("/api/conversations").then(
        (response) => response.conversations,
      ),
    enabled: Boolean(session),
    refetchInterval: 30_000,
  });

  const conversations = conversationsQuery.data ?? [];
  const selected = conversations.find((item) => item.id === conversationId) ?? null;
  const conversationIds = conversations.map((item) => item.id);

  if (!session || !identity) return null;

  return (
    <RealtimeProvider enabled conversationIds={conversationIds}>
      <ChatShell
        username={session.user.username}
        currentUserId={session.user.id}
        identity={identity}
        conversations={conversations}
        selected={selected}
        loading={conversationsQuery.isLoading}
        isAdmin={session.user.isAdmin === true}
        onSelect={(id) => navigate(`/c/${id}`)}
        onSelectMessage={(id, messageId) => navigate(`/c/${id}?anchor=${messageId}`)}
        onBack={() => navigate("/")}
        onNewConversation={() => setDialogOpen(true)}
        onOpenMoments={() => navigate("/moments")}
        onOpenContacts={() => navigate("/contacts")}
        onOpenDevices={() => navigate("/devices")}
        onOpenAdmin={() => navigate("/admin")}
        onLogout={() => {
          void logout().then(() => navigate("/"));
        }}
      />
      <NewConversationDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(id) => {
          void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          navigate(`/c/${id}`);
        }}
      />
    </RealtimeProvider>
  );
}

function ChatShell({
  username,
  currentUserId,
  identity,
  conversations,
  selected,
  loading,
  isAdmin,
  onSelect,
  onSelectMessage,
  onBack,
  onNewConversation,
  onOpenMoments,
  onOpenContacts,
  onOpenDevices,
  onOpenAdmin,
  onLogout,
}: {
  username: string;
  currentUserId: string;
  identity: NonNullable<ReturnType<typeof useSession>["identity"]>;
  conversations: ConversationSummary[];
  selected: ConversationSummary | null;
  loading: boolean;
  isAdmin: boolean;
  onSelect: (id: string) => void;
  onSelectMessage: (id: string, messageId: string) => void;
  onBack: () => void;
  onNewConversation: () => void;
  onOpenMoments: () => void;
  onOpenContacts: () => void;
  onOpenDevices: () => void;
  onOpenAdmin: () => void;
  onLogout: () => void;
}) {
  const { status } = useRealtime();
  const selectedId = selected?.id ?? null;

  return (
    <div className="flex h-dvh overflow-hidden bg-white">
      <div
        className={cn(
          "h-full w-full md:block md:w-80 md:shrink-0",
          selectedId ? "hidden" : "block",
        )}
      >
        <ConversationSidebar
          conversations={conversations}
          selectedId={selectedId}
          displayName={username}
          connection={status}
          isAdmin={isAdmin}
          onSelect={onSelect}
          onSelectMessage={onSelectMessage}
          onNewConversation={onNewConversation}
          onOpenMoments={onOpenMoments}
          onOpenContacts={onOpenContacts}
          onOpenDevices={onOpenDevices}
          onOpenAdmin={onOpenAdmin}
          onLogout={onLogout}
        />
      </div>

      <main
        className={cn(
          "h-full min-w-0 flex-1",
          selectedId ? "block" : "hidden md:block",
        )}
      >
        {selected ? (
          <ChatView
            conversation={selected}
            identity={identity}
            currentUserId={currentUserId}
            onBack={onBack}
            onLeft={onBack}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
            {loading ? (
              <Spinner className="h-6 w-6 text-accent-600" />
            ) : (
              <>
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-50 text-accent-600">
                  <MessagesSquare className="h-7 w-7" aria-hidden />
                </span>
                <div>
                  <p className="text-base font-medium text-zinc-900">
                    대화를 선택하세요
                  </p>
                </div>
                <Button onClick={onNewConversation}>
                  <Plus className="h-4 w-4" aria-hidden />새 대화 시작
                </Button>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
