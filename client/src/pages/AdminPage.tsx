import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, KeyRound, RefreshCw, Search, ShieldAlert, Smartphone } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { AdminDecoyPanel } from "../components/AdminDecoyPanel.tsx";
import { Alert, Avatar, Button, Card, Dialog, Input, Label, Spinner } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { formatBytes } from "../lib/format.ts";
import { useSession } from "../session.tsx";
import type {
  AdminAuditEntry,
  AdminOverview,
  AdminUserDetail,
  AdminUserPage,
  DecoyProfile,
} from "../types.ts";

const TABS = [
  { id: "overview", label: "개요" },
  { id: "users", label: "사용자" },
  { id: "decoy", label: "Decoy" },
  { id: "audit", label: "감사 로그" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const ACTION_LABELS: Record<string, string> = {
  "user.sessions.revoked": "세션 강제 종료",
  "decoy.created": "decoy 생성",
  "decoy.password.rotated": "decoy 비밀번호 회전",
  "decoy.disabled": "decoy 비활성화",
  "decoy.enabled": "decoy 활성화",
};

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "요청이 실패했습니다.";
}

function Loading() {
  return (
    <div className="flex justify-center py-10">
      <Spinner className="h-5 w-5 text-violet-600" />
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-zinc-900">{value}</p>
      {hint ? <p className="mt-1 text-xs text-zinc-400">{hint}</p> : null}
    </Card>
  );
}

function AccessDenied() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4">
      <Card className="w-full max-w-md p-6 text-center">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
          <ShieldAlert className="h-6 w-6" aria-hidden />
        </span>
        <h1 className="text-lg font-semibold text-zinc-900">관리자 권한이 없습니다</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          이 화면은 ADMIN_USERNAMES allowlist 에 등록된 관리자만 사용할 수 있습니다.
        </p>
        <Button className="mt-5 w-full" onClick={() => navigate("/")}>
          채팅으로 돌아가기
        </Button>
      </Card>
    </div>
  );
}

export function AdminPage() {
  const { session } = useSession();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>("overview");

  if (!session) return null;
  if (!session.user.isAdmin) return <AccessDenied />;

  return (
    <div className="min-h-dvh bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/")}
            aria-label="채팅으로 돌아가기"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Button>
          <div>
            <p className="text-xs font-medium tracking-wide text-violet-600">OneMoments</p>
            <h1 className="text-lg font-semibold text-zinc-900">관리자 콘솔</h1>
          </div>
          <span className="ml-auto text-xs text-zinc-500">@{session.user.username}</span>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 px-4 pb-2" aria-label="관리자 탭">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              aria-current={tab === item.id ? "page" : undefined}
              className={
                tab === item.id
                  ? "rounded-lg bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-700"
                  : "rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
              }
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        {tab === "overview" ? <OverviewTab /> : null}
        {tab === "users" ? <UsersTab /> : null}
        {tab === "decoy" ? <AdminDecoyPanel /> : null}
        {tab === "audit" ? <AuditTab /> : null}
      </main>
    </div>
  );
}

function OverviewTab() {
  const overviewQuery = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () =>
      api<{ overview: AdminOverview }>("/api/admin/overview").then(
        (response) => response.overview,
      ),
    refetchInterval: 30_000,
  });

  if (overviewQuery.isLoading) return <Loading />;
  if (overviewQuery.isError) {
    return <Alert variant="error">{errorMessage(overviewQuery.error)}</Alert>;
  }
  const overview = overviewQuery.data;
  if (!overview) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900">서버 현황</h2>
        <Button variant="outline" size="sm" onClick={() => void overviewQuery.refetch()}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          새로고침
        </Button>
      </div>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="서버 통계">
        <Stat label="사용자" value={overview.usersTotal} hint={`삭제 ${overview.usersDeleted}명`} />
        <Stat
          label="활성 기기"
          value={overview.devicesActive}
          hint={`폐기 ${overview.devicesRevoked}대`}
        />
        <Stat label="활성 세션" value={overview.activeSessions} />
        <Stat label="푸시 구독" value={overview.pushSubscriptions} />
        <Stat label="1:1 대화" value={overview.directConversations} />
        <Stat label="그룹 대화" value={overview.groupConversations} />
        <Stat label="메시지" value={overview.messages} hint="암호문 기준" />
        <Stat
          label="첨부"
          value={overview.attachments}
          hint={`암호문 ${formatBytes(overview.attachmentBytes)}`}
        />
        <Stat
          label="Decoy 프로필"
          value={overview.decoyProfiles}
          hint={`비활성 ${overview.decoyProfilesDisabled}개`}
        />
      </section>
      <Card className="p-4">
        <h3 className="text-sm font-semibold text-zinc-900">메타데이터만 표시합니다</h3>
        <p className="mt-1 text-sm leading-relaxed text-zinc-500">
          서버는 메시지 평문·대화 키·기기 개인키를 보관하지 않습니다. 이 화면에서도 메시지 내용과
          세션 토큰은 조회할 수 없습니다.
        </p>
      </Card>
    </div>
  );
}

function UsersTab() {
  const [search, setSearch] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const usersQuery = useInfiniteQuery({
    queryKey: ["admin", "users", appliedQuery],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (appliedQuery) params.set("query", appliedQuery);
      if (pageParam) params.set("cursor", pageParam);
      const suffix = params.toString();
      return api<AdminUserPage>(`/api/admin/users${suffix ? `?${suffix}` : ""}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const users = usersQuery.data?.pages.flatMap((page) => page.users) ?? [];

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSelectedId(null);
    setAppliedQuery(search.trim());
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <form onSubmit={onSubmit} className="flex gap-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="username 검색"
            aria-label="username 검색"
            maxLength={32}
          />
          <Button type="submit" variant="outline">
            <Search className="h-4 w-4" aria-hidden />
            검색
          </Button>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {usersQuery.isLoading ? (
          <Loading />
        ) : usersQuery.isError && !usersQuery.data ? (
          <div className="p-4">
            <Alert variant="error">{errorMessage(usersQuery.error)}</Alert>
          </div>
        ) : users.length > 0 ? (
          <>
            <ul className="divide-y divide-zinc-100">
              {users.map((user) => (
                <li key={user.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(user.id)}
                    aria-current={selectedId === user.id ? "true" : undefined}
                    className={
                      selectedId === user.id
                        ? "flex w-full items-center gap-3 bg-violet-50 px-4 py-3 text-left"
                        : "flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50"
                    }
                  >
                    <Avatar name={user.username} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-zinc-900">
                          @{user.username}
                        </span>
                        {user.deleted ? (
                          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                            삭제됨
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-xs text-zinc-500">
                        기기 {user.activeDeviceCount} · 세션 {user.activeSessionCount} · 가입{" "}
                        {formatDateTime(user.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 px-4 py-3">
              <p className="text-xs text-zinc-500">{users.length}명 표시</p>
              {usersQuery.hasNextPage ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void usersQuery.fetchNextPage()}
                  disabled={usersQuery.isFetchingNextPage}
                >
                  {usersQuery.isFetchingNextPage ? <Spinner /> : null}
                  더 보기
                </Button>
              ) : null}
            </div>
            {usersQuery.isFetchNextPageError ? (
              <div className="px-4 pb-3">
                <Alert variant="error">{errorMessage(usersQuery.error)}</Alert>
              </div>
            ) : null}
          </>
        ) : (
          <p className="px-4 py-10 text-center text-sm text-zinc-500">
            해당하는 사용자가 없습니다.
          </p>
        )}
      </Card>

      {selectedId ? (
        <UserDetailPanel userId={selectedId} onClose={() => setSelectedId(null)} />
      ) : null}
    </div>
  );
}

function UserDetailPanel({ userId, onClose }: { userId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ["admin", "user", userId],
    queryFn: () =>
      api<{ user: AdminUserDetail }>(`/api/admin/users/${userId}`).then(
        (response) => response.user,
      ),
  });

  const revoke = useMutation({
    mutationFn: () =>
      api<{ revokedSessions: number }>(`/api/admin/users/${userId}/revoke-sessions`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      setNotice(`세션 ${result.revokedSessions}개를 종료했습니다.`);
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
  });

  if (detailQuery.isLoading) {
    return (
      <Card className="p-4">
        <Loading />
      </Card>
    );
  }
  if (detailQuery.isError) {
    return (
      <Card className="p-4">
        <Alert variant="error">{errorMessage(detailQuery.error)}</Alert>
      </Card>
    );
  }
  const detail = detailQuery.data;
  if (!detail) return null;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={detail.user.username} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            @{detail.user.username}
            {detail.user.deleted ? (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                삭제됨
              </span>
            ) : null}
          </p>
          <p className="text-xs text-zinc-500">가입 {formatDateTime(detail.user.createdAt)}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onClose}>
          닫기
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={revoke.isPending}
        >
          <KeyRound className="h-4 w-4" aria-hidden />
          세션 종료
        </Button>
      </div>

      {detail.decoy ? (
        <div className="mt-3">
          <Alert>
            이 계정에는 decoy 프로필이 연결되어 있습니다 (alias @{detail.decoy.alias}
            {detail.decoy.disabledAt ? ", 비활성" : ""}).
          </Alert>
        </div>
      ) : null}
      {notice ? (
        <div className="mt-3">
          <Alert>{notice}</Alert>
        </div>
      ) : null}
      {revoke.isError ? (
        <div className="mt-3">
          <Alert variant="error">{errorMessage(revoke.error)}</Alert>
        </div>
      ) : null}

      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["대화", detail.counts.conversations],
          ["메시지", detail.counts.messages],
          ["첨부", detail.counts.attachments],
          ["푸시 구독", detail.counts.pushSubscriptions],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg bg-zinc-50 px-3 py-2">
            <dt className="text-xs text-zinc-500">{label}</dt>
            <dd className="text-sm font-semibold text-zinc-900">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
            <Smartphone className="h-4 w-4" aria-hidden />
            기기 ({detail.devices.length})
          </h3>
          <ul className="mt-2 space-y-2">
            {detail.devices.map((device) => (
              <li key={device.id} className="rounded-lg border border-zinc-100 px-3 py-2">
                <p className="text-sm text-zinc-900">
                  {device.name}
                  {device.revokedAt ? " · 폐기됨" : ""}
                </p>
                <p className="text-xs text-zinc-500">
                  등록 {formatDateTime(device.createdAt)} · 마지막 {formatDateTime(device.lastSeenAt)}
                </p>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="text-sm font-semibold text-zinc-900">
            세션 ({detail.sessions.length})
          </h3>
          <ul className="mt-2 space-y-2">
            {detail.sessions.map((session) => (
              <li key={session.id} className="rounded-lg border border-zinc-100 px-3 py-2">
                <p className="text-sm text-zinc-900">만료 {formatDateTime(session.expiresAt)}</p>
                <p className="truncate text-xs text-zinc-500">
                  최근 {formatDateTime(session.lastSeenAt)}
                  {session.userAgent ? ` · ${session.userAgent}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title="세션 강제 종료">
        <p className="text-sm leading-relaxed text-zinc-600">
          @{detail.user.username} 의 모든 세션을 종료하고 푸시 구독을 삭제합니다. 기기와 키는
          유지되며, 다음 로그인에서 새 세션이 발급됩니다.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmOpen(false)}>
            취소
          </Button>
          <Button variant="destructive" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
            {revoke.isPending ? "종료 중" : "종료"}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

function AuditTab() {
  const auditQuery = useQuery({
    queryKey: ["admin", "audit"],
    queryFn: () =>
      api<{ entries: AdminAuditEntry[] }>("/api/admin/audit").then((response) => response.entries),
  });

  if (auditQuery.isLoading) return <Loading />;
  if (auditQuery.isError) {
    return <Alert variant="error">{errorMessage(auditQuery.error)}</Alert>;
  }

  return (
    <Card className="overflow-hidden">
      {auditQuery.data && auditQuery.data.length > 0 ? (
        <ul className="divide-y divide-zinc-100">
          {auditQuery.data.map((entry) => (
            <li key={entry.id} className="px-4 py-3">
              <p className="text-sm text-zinc-900">
                {ACTION_LABELS[entry.action] ?? entry.action}
                {entry.targetUsername ? (
                  <span className="text-zinc-500"> · @{entry.targetUsername}</span>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs text-zinc-500">
                관리자 @{entry.adminUsername} · {formatDateTime(entry.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-10 text-center text-sm text-zinc-500">감사 기록이 없습니다.</p>
      )}
    </Card>
  );
}
