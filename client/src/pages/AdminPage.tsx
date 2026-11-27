import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, KeyRound, RefreshCw, Search, ShieldAlert, Smartphone } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { AdminDecoyPanel } from "../components/AdminDecoyPanel.tsx";
import { AdminSignupInvitesPanel } from "../components/AdminSignupInvitesPanel.tsx";
import { AdminSignupRequestsPanel } from "../components/AdminSignupRequestsPanel.tsx";
import { AdminDevicesPanel } from "../components/AdminDevicesPanel.tsx";
import { Alert, Avatar, Button, Card, Dialog, Input, Label, Spinner } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { formatBytes } from "../lib/format.ts";
import { useI18n } from "../i18n.tsx";
import { useSession } from "../session.tsx";
import type {
  AdminAuditEntry,
  AdminAuthEventPage,
  AdminOverview,
  AdminUserDetail,
  AdminUserPage,
  DecoyProfile,
} from "../types.ts";

const TABS = [
  { id: "overview", label: "admin.tab.overview" },
  { id: "users", label: "admin.tab.users" },
  { id: "devices", label: "admin.tab.devices" },
  { id: "decoy", label: "admin.tab.decoy" },
  { id: "invites", label: "admin.tab.invites" },
  { id: "requests", label: "admin.tab.requests" },
  { id: "audit", label: "admin.tab.audit" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** 인증 이벤트 라벨. 서버는 이벤트 코드만 저장한다. */
const AUTH_EVENT_LABELS: Record<string, string> = {
  register: "admin.event.register",
  login: "admin.event.login",
  logout: "admin.event.logout",
  device_logout: "admin.event.deviceLogout",
  device_revoked: "admin.event.deviceRevoked",
  recover: "admin.event.recover",
  admin_sessions_revoked: "admin.event.adminSessionsRevoked",
  admin_signup_invite_created: "admin.event.signupInviteCreated",
  admin_signup_invite_revoked: "admin.event.signupInviteRevoked",
};

const ACTION_LABELS: Record<string, string> = {
  "user.sessions.revoked": "admin.action.userSessionsRevoked",
  "decoy.created": "admin.action.decoyCreated",
  "decoy.password.rotated": "admin.action.decoyRotated",
  "decoy.disabled": "admin.action.decoyDisabled",
  "decoy.enabled": "admin.action.decoyEnabled",
  "signup.request.approved": "admin.action.signupRequestApproved",
  "signup.request.rejected": "admin.action.signupRequestRejected",
};

function formatDateTime(value: string | null, locale: string = "ko"): string {
  if (!value) return "-";
  return new Date(value).toLocaleString(locale === "en" ? "en-US" : "ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "admin.requestFailed";
}

function Loading() {
  return (
    <div className="flex justify-center py-10">
      <Spinner className="h-5 w-5 text-accent-600" />
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
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4">
      <Card className="w-full max-w-md p-6 text-center">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
          <ShieldAlert className="h-6 w-6" aria-hidden />
        </span>
        <h1 className="text-lg font-semibold text-zinc-900">{t("admin.noAccess")}</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          {t("admin.noAccessNote")}
        </p>
        <Button className="mt-5 w-full" onClick={() => navigate("/")}>
          {t("admin.backToChat")}
        </Button>
      </Card>
    </div>
  );
}

export function AdminPage() {
  const { t } = useI18n();
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
            aria-label={t("admin.backToChat")}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Button>
          <div>
            <p className="text-xs font-medium tracking-wide text-accent-600">OneMoments</p>
            <h1 className="text-lg font-semibold text-zinc-900">{t("admin.title")}</h1>
          </div>
          <span className="ml-auto text-xs text-zinc-500">@{session.user.username}</span>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 px-4 pb-2" aria-label={t("admin.tabsAria")}>
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              aria-current={tab === item.id ? "page" : undefined}
              className={
                tab === item.id
                  ? "rounded-lg bg-accent-50 px-3 py-1.5 text-sm font-medium text-accent-700"
                  : "rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
              }
            >
              {t(item.label)}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        {tab === "overview" ? <OverviewTab /> : null}
        {tab === "users" ? <UsersTab /> : null}
        {tab === "devices" ? <AdminDevicesPanel /> : null}
        {tab === "decoy" ? <AdminDecoyPanel /> : null}
      {tab === "invites" ? <AdminSignupInvitesPanel /> : null}
      {tab === "requests" ? <AdminSignupRequestsPanel /> : null}
        {tab === "audit" ? <AuditTab /> : null}
      </main>
    </div>
  );
}

function OverviewTab() {
  const { t } = useI18n();
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
    return <Alert variant="error">{t(errorMessage(overviewQuery.error))}</Alert>;
  }
  const overview = overviewQuery.data;
  if (!overview) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900">{t("admin.statusTitle")}</h2>
        <Button variant="outline" size="sm" onClick={() => void overviewQuery.refetch()}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {t("admin.refresh")}
        </Button>
      </div>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={t("admin.statsAria")}>
        <Stat
          label={t("admin.stat.users")}
          value={overview.usersTotal}
          hint={t("admin.stat.usersHint", { count: overview.usersDeleted })}
        />
        <Stat
          label={t("admin.stat.devices")}
          value={overview.devicesActive}
          hint={t("admin.stat.devicesHint", { count: overview.devicesRevoked })}
        />
        <Stat label={t("admin.stat.sessions")} value={overview.activeSessions} />
        <Stat label={t("admin.stat.push")} value={overview.pushSubscriptions} />
        <Stat label={t("admin.stat.direct")} value={overview.directConversations} />
        <Stat label={t("admin.stat.group")} value={overview.groupConversations} />
        <Stat label={t("admin.stat.messages")} value={overview.messages} hint={t("admin.stat.messagesHint")} />
        <Stat
          label={t("admin.stat.attachments")}
          value={overview.attachments}
          hint={t("admin.stat.attachmentsHint", { size: formatBytes(overview.attachmentBytes) })}
        />
        <Stat
          label={t("admin.stat.decoy")}
          value={overview.decoyProfiles}
          hint={t("admin.stat.decoyHint", { count: overview.decoyProfilesDisabled })}
        />
      </section>
      <Card className="p-4">
        <h3 className="text-sm font-semibold text-zinc-900">{t("admin.metaTitle")}</h3>
        <p className="mt-1 text-sm leading-relaxed text-zinc-500">
          {t("admin.metaNote")}
        </p>
      </Card>
    </div>
  );
}

function UsersTab() {
  const { t, locale } = useI18n();
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
            placeholder={t("admin.searchPlaceholder")}
            aria-label={t("admin.searchPlaceholder")}
            maxLength={32}
          />
          <Button type="submit" variant="outline">
            <Search className="h-4 w-4" aria-hidden />
            {t("admin.search")}
          </Button>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {usersQuery.isLoading ? (
          <Loading />
        ) : usersQuery.isError && !usersQuery.data ? (
          <div className="p-4">
            <Alert variant="error">{t(errorMessage(usersQuery.error))}</Alert>
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
                        ? "flex w-full items-center gap-3 bg-accent-50 px-4 py-3 text-left"
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
                            {t("admin.deleted")}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-xs text-zinc-500">
                        {t("admin.userMeta", {
                          devices: user.activeDeviceCount,
                          sessions: user.activeSessionCount,
                          date: formatDateTime(user.createdAt, locale),
                        })}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 px-4 py-3">
              <p className="text-xs text-zinc-500">{t("admin.usersShown", { count: users.length })}</p>
              {usersQuery.hasNextPage ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void usersQuery.fetchNextPage()}
                  disabled={usersQuery.isFetchingNextPage}
                >
                  {usersQuery.isFetchingNextPage ? <Spinner /> : null}
                  {t("admin.loadMore")}
                </Button>
              ) : null}
            </div>
            {usersQuery.isFetchNextPageError ? (
              <div className="px-4 pb-3">
                <Alert variant="error">{t(errorMessage(usersQuery.error))}</Alert>
              </div>
            ) : null}
          </>
        ) : (
          <p className="px-4 py-10 text-center text-sm text-zinc-500">
            {t("admin.usersEmpty")}
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
  const { t, locale } = useI18n();
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
      setNotice(t("admin.sessionsRevoked", { count: result.revokedSessions }));
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
  });

  const authEventsQuery = useInfiniteQuery({
    queryKey: ["admin", "auth-events", userId],
    queryFn: ({ pageParam }) =>
      api<AdminAuthEventPage>(
        `/api/admin/users/${userId}/auth-events?limit=20${
          pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""
        }`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
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
        <Alert variant="error">{t(errorMessage(detailQuery.error))}</Alert>
      </Card>
    );
  }
  const detail = detailQuery.data;
  if (!detail) return null;
  const authEvents = (authEventsQuery.data?.pages ?? []).flatMap((page) => page.events);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={detail.user.username} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            @{detail.user.username}
            {detail.user.deleted ? (
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                {t("admin.deleted")}
              </span>
            ) : null}
          </p>
          <p className="text-xs text-zinc-500">{t("admin.joinedAt", { date: formatDateTime(detail.user.createdAt, locale) })}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t("admin.close")}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={revoke.isPending}
        >
          <KeyRound className="h-4 w-4" aria-hidden />
          {t("admin.revokeSessions")}
        </Button>
      </div>

      {detail.decoy ? (
        <div className="mt-3">
          <Alert>
            {t("admin.decoyLinked", {
              alias: detail.decoy.alias,
              disabled: detail.decoy.disabledAt ? t("admin.decoyDisabledSuffix") : "",
            })}
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
          <Alert variant="error">{t(errorMessage(revoke.error))}</Alert>
        </div>
      ) : null}

      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          [t("admin.count.conversations"), detail.counts.conversations],
          [t("admin.count.messages"), detail.counts.messages],
          [t("admin.count.attachments"), detail.counts.attachments],
          [t("admin.count.push"), detail.counts.pushSubscriptions],
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
            {t("admin.devicesTitle", { count: detail.devices.length })}
          </h3>
          <ul className="mt-2 space-y-2">
            {detail.devices.map((device) => (
              <li key={device.id} className="rounded-lg border border-zinc-100 px-3 py-2">
                <p className="text-sm text-zinc-900">
                  {device.name}
                  {device.revokedAt ? t("admin.deviceRevokedSuffix") : ""}
                </p>
                <p className="text-xs text-zinc-500">
                  {t("admin.deviceRegistered", {
                    registered: formatDateTime(device.createdAt, locale),
                    lastSeen: formatDateTime(device.lastSeenAt, locale),
                  })}
                </p>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className="text-sm font-semibold text-zinc-900">
            {t("admin.sessionsTitle", { count: detail.sessions.length })}
          </h3>
          <ul className="mt-2 space-y-2">
            {detail.sessions.map((session) => (
              <li key={session.id} className="rounded-lg border border-zinc-100 px-3 py-2">
                <p className="text-sm text-zinc-900">{t("admin.sessionExpires", { date: formatDateTime(session.expiresAt, locale) })}</p>
                <p className="truncate text-xs text-zinc-500">
                  {t("admin.sessionLastSeen", { date: formatDateTime(session.lastSeenAt, locale) })}
                  {session.userAgent ? ` · ${session.userAgent}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="mt-5">
        <h3 className="text-sm font-semibold text-zinc-900">
          {authEvents.length > 0 ? t("admin.authTitleCount", { count: authEvents.length }) : t("admin.authTitle")}
        </h3>
        <p className="mt-1 text-xs text-zinc-500">
          {t("admin.authNote")}
        </p>
        {authEventsQuery.isLoading ? (
          <div className="mt-2">
            <Spinner className="h-4 w-4 text-violet-600" />
          </div>
        ) : authEventsQuery.isError ? (
          <div className="mt-2">
            <Alert variant="error">{t("admin.authLoadFailed")}</Alert>
          </div>
        ) : (
          <>
            <ul className="mt-2 space-y-1.5">
              {authEvents.map((event) => (
                <li key={event.id} className="rounded-lg border border-zinc-100 px-3 py-2">
                  <p className="flex items-center justify-between gap-2 text-sm text-zinc-900">
                    <span className="font-medium">
                      {t(AUTH_EVENT_LABELS[event.event] ?? event.event)}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {formatDateTime(event.createdAt)}
                    </span>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {t("admin.authIp", { ip: event.ip ?? t("admin.authNoIp") })}
                    {event.deviceId ? t("admin.authDevice", { id: event.deviceId.slice(0, 8) }) : ""}
                    {event.userAgent ? ` · ${event.userAgent}` : ""}
                  </p>
                </li>
              ))}
              {authEvents.length === 0 ? (
                <li className="text-xs text-zinc-500">{t("admin.authEmpty")}</li>
              ) : null}
            </ul>
            {authEventsQuery.hasNextPage ? (
              <div className="mt-2 flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void authEventsQuery.fetchNextPage()}
                  disabled={authEventsQuery.isFetchingNextPage}
                >
                  {authEventsQuery.isFetchingNextPage ? t("admin.loading") : t("admin.loadMore")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </section>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title={t("admin.revokeTitle")}>
        <p className="text-sm leading-relaxed text-zinc-600">
          {t("admin.revokeNote", { username: detail.user.username })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmOpen(false)}>
            {t("admin.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
            {revoke.isPending ? t("admin.revoking") : t("admin.revoke")}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

function AuditTab() {
  const { t, locale } = useI18n();
  const auditQuery = useQuery({
    queryKey: ["admin", "audit"],
    queryFn: () =>
      api<{ entries: AdminAuditEntry[] }>("/api/admin/audit").then((response) => response.entries),
  });

  if (auditQuery.isLoading) return <Loading />;
  if (auditQuery.isError) {
    return <Alert variant="error">{t(errorMessage(auditQuery.error))}</Alert>;
  }

  return (
    <Card className="overflow-hidden">
      {auditQuery.data && auditQuery.data.length > 0 ? (
        <ul className="divide-y divide-zinc-100">
          {auditQuery.data.map((entry) => (
            <li key={entry.id} className="px-4 py-3">
              <p className="text-sm text-zinc-900">
                {t(ACTION_LABELS[entry.action] ?? entry.action)}
                {entry.targetUsername ? (
                  <span className="text-zinc-500"> · @{entry.targetUsername}</span>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs text-zinc-500">
                {t("admin.auditEntry", { admin: entry.adminUsername, date: formatDateTime(entry.createdAt, locale) })}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-10 text-center text-sm text-zinc-500">{t("admin.auditEmpty")}</p>
      )}
    </Card>
  );
}
