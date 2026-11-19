import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Ban,
  Check,
  MessageSquare,
  Star,
  UserRound,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  Alert,
  Avatar,
  Button,
  Card,
  Dialog,
  Input,
  Spinner,
  cn,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { useSession } from "../session.tsx";
import type { ContactView } from "../types.ts";

export function ContactsPage() {
  const { session, updateStatusMessage } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [statusDraft, setStatusDraft] = useState(session?.user.statusMessage ?? "");
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [blockTarget, setBlockTarget] = useState<ContactView | null>(null);

  useEffect(() => {
    setStatusDraft(session?.user.statusMessage ?? "");
  }, [session?.user.statusMessage]);

  const contactsQuery = useQuery({
    queryKey: ["contacts"],
    queryFn: () =>
      api<{ contacts: ContactView[] }>("/api/contacts").then(
        (response) => response.contacts,
      ),
    enabled: Boolean(session),
  });

  function invalidateContactData(): void {
    void queryClient.invalidateQueries({ queryKey: ["contacts"] });
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  }

  const favoriteMutation = useMutation({
    mutationFn: (input: { userId: string; favorite: boolean }) =>
      api(`/api/contacts/${input.userId}/favorite`, {
        method: "PUT",
        body: { favorite: input.favorite },
      }),
    onSuccess: invalidateContactData,
  });

  const blockMutation = useMutation({
    mutationFn: (input: { userId: string; blocked: boolean }) =>
      api(`/api/contacts/${input.userId}/block`, {
        method: "PUT",
        body: { blocked: input.blocked },
      }),
    onSuccess: () => {
      setBlockTarget(null);
      invalidateContactData();
    },
  });

  const openMutation = useMutation({
    mutationFn: (userId: string) =>
      api<{ conversation: { id: string } }>("/api/conversations", {
        method: "POST",
        body: { peerUserId: userId },
      }),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      navigate(`/c/${response.conversation.id}`);
    },
  });

  if (!session) return null;
  const contacts = contactsQuery.data ?? [];

  async function saveStatus(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatusBusy(true);
    setStatusError(null);
    setStatusMessage(null);
    try {
      await updateStatusMessage(statusDraft.trim() || null);
      setStatusMessage("상태 메시지를 저장했습니다.");
    } catch {
      setStatusError("상태 메시지를 저장하지 못했습니다.");
    } finally {
      setStatusBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/")}
            aria-label="대화로 돌아가기"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold text-zinc-900">연락처</h1>
            <p className="text-xs text-zinc-500">프로필과 대화 상대를 관리합니다</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-5 px-4 py-6">
        <Card className="p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <UserRound className="h-4 w-4 text-accent-600" aria-hidden />
            내 프로필
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            @{session.user.username} · 상태 메시지는 대화 상대에게 공개됩니다.
          </p>
          <form className="mt-4" onSubmit={(event) => void saveStatus(event)}>
            <Input
              value={statusDraft}
              maxLength={80}
              onChange={(event) => {
                setStatusDraft(event.target.value);
                setStatusMessage(null);
              }}
              placeholder="상태 메시지 (최대 80자)"
              aria-label="상태 메시지"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-[11px] text-zinc-400">
                {statusDraft.length}/80 · 메시지와 달리 서버에 일반 텍스트로 저장되는 공개
                프로필 정보입니다.
              </p>
              <Button type="submit" size="sm" disabled={statusBusy}>
                {statusBusy ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <Check className="h-4 w-4" aria-hidden />
                )}
                저장
              </Button>
            </div>
          </form>
          {statusMessage ? (
            <p className="mt-2 text-xs text-emerald-700">{statusMessage}</p>
          ) : null}
          {statusError ? (
            <div className="mt-2">
              <Alert variant="error">{statusError}</Alert>
            </div>
          ) : null}
        </Card>

        <section aria-label="연락처 목록">
          <div className="mb-2 flex items-baseline justify-between px-1">
            <h2 className="text-sm font-semibold text-zinc-900">대화 상대</h2>
            <span className="text-xs text-zinc-500">{contacts.length}명</span>
          </div>

          {favoriteMutation.isError || blockMutation.isError || openMutation.isError ? (
            <div className="mb-2">
              <Alert variant="error">
                연락처 설정을 변경하지 못했습니다. 잠시 후 다시 시도해 주세요.
              </Alert>
            </div>
          ) : null}

          {contactsQuery.isLoading ? (
            <div className="flex justify-center py-10">
              <Spinner className="h-5 w-5 text-accent-600" />
            </div>
          ) : contactsQuery.isError ? (
            <Alert variant="error">연락처를 불러오지 못했습니다.</Alert>
          ) : contacts.length === 0 ? (
            <Card className="px-4 py-10 text-center text-sm leading-relaxed text-zinc-500">
              아직 대화 상대가 없습니다.
              <br />
              대화를 시작하면 여기에 표시됩니다.
            </Card>
          ) : (
            <ul className="space-y-2">
              {contacts.map((contact) => {
                const blocked = contact.blockedByMe;
                return (
                  <li key={contact.id}>
                    <Card className="flex items-center gap-3 p-3">
                      <Avatar name={contact.username} />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium text-zinc-900">
                          {contact.username}
                          {contact.favorite ? (
                            <Star
                              className="h-3.5 w-3.5 fill-amber-400 text-amber-500"
                              aria-label="즐겨찾기"
                            />
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-zinc-500">
                          {contact.statusMessage ?? "상태 메시지 없음"}
                        </p>
                        {contact.blockedMe ? (
                          <p className="mt-0.5 text-[11px] text-amber-700">
                            상대가 나를 차단했습니다.
                          </p>
                        ) : null}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={contact.favorite ? "즐겨찾기 해제" : "즐겨찾기"}
                        title={contact.favorite ? "즐겨찾기 해제" : "즐겨찾기"}
                        disabled={blocked || favoriteMutation.isPending}
                        onClick={() =>
                          favoriteMutation.mutate({
                            userId: contact.id,
                            favorite: !contact.favorite,
                          })
                        }
                      >
                        <Star
                          className={cn(
                            "h-4 w-4",
                            contact.favorite
                              ? "fill-amber-400 text-amber-500"
                              : "text-zinc-400",
                          )}
                          aria-hidden
                        />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={blocked ? "차단 해제" : "차단"}
                        title={blocked ? "차단 해제" : "차단"}
                        disabled={blockMutation.isPending}
                        onClick={() => {
                          if (blocked) {
                            blockMutation.mutate({ userId: contact.id, blocked: false });
                          } else {
                            setBlockTarget(contact);
                          }
                        }}
                      >
                        {blocked ? (
                          <Check className="h-4 w-4 text-emerald-600" aria-hidden />
                        ) : (
                          <Ban className="h-4 w-4 text-zinc-400" aria-hidden />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${contact.username}님과 대화`}
                        title="대화 열기"
                        disabled={blocked || contact.blockedMe || openMutation.isPending}
                        onClick={() => openMutation.mutate(contact.id)}
                      >
                        <MessageSquare className="h-4 w-4 text-zinc-400" aria-hidden />
                      </Button>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <p className="px-1 text-center text-[11px] text-zinc-400">
          차단하면 1:1 대화의 메시지 전송이 양방향으로 막힙니다.
          <br />
          <Link className="underline hover:text-zinc-600" to="/">
            대화 목록으로
          </Link>
        </p>
      </main>

      <Dialog
        open={blockTarget !== null}
        onClose={() => setBlockTarget(null)}
        title="연락처 차단"
      >
        <p className="text-sm leading-relaxed text-zinc-600">
          {blockTarget ? `@${blockTarget.username}님을 차단할까요?` : ""} 차단하면 서로 1:1
          메시지를 보낼 수 없고, 즐겨찾기도 해제됩니다. 언제든 연락처에서 차단을 해제할 수
          있습니다.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setBlockTarget(null)}>
            취소
          </Button>
          <Button
            variant="destructive"
            disabled={blockMutation.isPending}
            onClick={() => {
              if (blockTarget) {
                blockMutation.mutate({ userId: blockTarget.id, blocked: true });
              }
            }}
          >
            <Ban className="h-4 w-4" aria-hidden />
            차단
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

