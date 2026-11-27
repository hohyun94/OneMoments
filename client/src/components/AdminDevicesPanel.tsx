import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Search, Smartphone } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Alert, Button, Card, Dialog, Input, Spinner } from "./ui.tsx";
import { api } from "../lib/api.ts";
import { useI18n } from "../i18n.tsx";
import { AdminDeviceSessionsPanel } from "./AdminDeviceSessionsPanel.tsx";
import type { AdminDeviceListItem, AdminDevicePage } from "../types.ts";

type StatusFilter = "active" | "revoked" | "all";

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "active", label: "admin.devices.filter.active" },
  { id: "revoked", label: "admin.devices.filter.revoked" },
  { id: "all", label: "admin.devices.filter.all" },
];

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

/**
 * 관리자 기기 목록 패널.
 * 소유자 username·기기 이름·등록/마지막 활동 시각만 보여주며,
 * 공개키·키 봉투·세션 토큰은 서버가 응답하지 않는다.
 */
export function AdminDevicesPanel() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [target, setTarget] = useState<AdminDeviceListItem | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const devicesQuery = useInfiniteQuery({
    queryKey: ["admin", "devices", appliedQuery, status],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ status });
      if (appliedQuery) params.set("query", appliedQuery);
      if (pageParam) params.set("cursor", pageParam);
      return api<AdminDevicePage>(`/api/admin/devices?${params.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const devices = devicesQuery.data?.pages.flatMap((page) => page.devices) ?? [];

  const revoke = useMutation({
    mutationFn: (deviceId: string) =>
      api<{ device: AdminDeviceListItem; revoked: boolean }>(
        `/api/admin/devices/${deviceId}/revoke`,
        { method: "POST" },
      ),
    onSuccess: (result) => {
      setTarget(null);
      setNotice(
        result.revoked
          ? t("admin.notice.deviceRevoked", {
              username: result.device.username,
              name: result.device.name,
            })
          : t("admin.notice.deviceAlreadyRevoked"),
      );
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
  });

  const closeDialog = () => {
    setTarget(null);
    revoke.reset();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppliedQuery(search.trim());
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("admin.devices.filterAria")}>
          {STATUS_FILTERS.map((item) => (
            <Button
              key={item.id}
              variant={status === item.id ? "default" : "outline"}
              size="sm"
              onClick={() => setStatus(item.id)}
              aria-pressed={status === item.id}
            >
              {t(item.label)}
            </Button>
          ))}
          <form onSubmit={onSubmit} className="ml-auto flex min-w-0 flex-1 gap-2 sm:max-w-sm">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("admin.devices.searchPlaceholder")}
              aria-label={t("admin.devices.searchAria")}
              maxLength={32}
            />
            <Button type="submit" variant="outline">
              <Search className="h-4 w-4" aria-hidden />
              {t("admin.search")}
            </Button>
          </form>
        </div>
        <p className="mt-3 text-xs text-zinc-500">{t("admin.devices.note")}</p>
      </Card>

      {notice ? <Alert>{notice}</Alert> : null}

      <Card className="overflow-hidden">
        {devicesQuery.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner className="h-5 w-5 text-accent-600" />
          </div>
        ) : devicesQuery.isError && !devicesQuery.data ? (
          <div className="p-4">
            <Alert variant="error">{t(errorMessage(devicesQuery.error))}</Alert>
          </div>
        ) : devices.length > 0 ? (
          <>
            <ul className="divide-y divide-zinc-100">
              {devices.map((device) => (
                <li key={device.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-500">
                    <Smartphone className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-zinc-900">
                        {device.name}
                      </span>
                      <span className="truncate text-xs text-accent-700">
                        @{device.username}
                      </span>
                      {device.revokedAt ? (
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                          {t("admin.devices.statusRevoked")}
                        </span>
                      ) : (
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                          {t("admin.devices.statusActive")}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-zinc-500">
                      {t("admin.devices.meta", {
                        registered: formatDateTime(device.createdAt, locale),
                        lastSeen: formatDateTime(device.lastSeenAt, locale),
                        revoked: device.revokedAt
                          ? t("admin.devices.metaRevoked", {
                              date: formatDateTime(device.revokedAt, locale),
                            })
                          : "",
                      })}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedDeviceId(device.id)}
                    aria-label={t("admin.devices.sessionsAria", { name: device.name })}
                  >
                    {t("admin.devices.sessionCount", { count: device.activeSessionCount })}
                  </Button>
                  {device.revokedAt ? null : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setTarget(device)}
                      aria-label={t("admin.devices.revokeAria", { name: device.name })}
                    >
                      <Ban className="h-3.5 w-3.5" aria-hidden />
                      {t("admin.devices.revoke")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 px-4 py-3">
              <p className="text-xs text-zinc-500">{t("admin.devices.shown", { count: devices.length })}</p>
              {devicesQuery.hasNextPage ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void devicesQuery.fetchNextPage()}
                  disabled={devicesQuery.isFetchingNextPage}
                >
                  {devicesQuery.isFetchingNextPage ? <Spinner /> : null}
                  {t("admin.loadMore")}
                </Button>
              ) : null}
            </div>
            {devicesQuery.isFetchNextPageError ? (
              <div className="px-4 pb-3">
                <Alert variant="error">{t(errorMessage(devicesQuery.error))}</Alert>
              </div>
            ) : null}
          </>
        ) : (
          <p className="px-4 py-10 text-center text-sm text-zinc-500">
            {t("admin.devices.empty")}
          </p>
        )}
      </Card>

      {selectedDeviceId ? (
        <AdminDeviceSessionsPanel
          deviceId={selectedDeviceId}
          onClose={() => setSelectedDeviceId(null)}
        />
      ) : null}

      <Dialog open={target !== null} onClose={closeDialog} title={t("admin.devices.revokeTitle")}>
        {target ? (
          <>
            <p className="text-sm leading-relaxed text-zinc-600">
              {t("admin.devices.revokeNote", { username: target.username, name: target.name })}
            </p>
            {revoke.isError ? (
              <div className="mt-3">
                <Alert variant="error">{t(errorMessage(revoke.error))}</Alert>
              </div>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={closeDialog} disabled={revoke.isPending}>
                {t("admin.cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => revoke.mutate(target.id)}
                disabled={revoke.isPending}
              >
                {revoke.isPending ? t("admin.devices.revoking") : t("admin.devices.revoke")}
              </Button>
            </div>
          </>
        ) : null}
      </Dialog>
    </div>
  );
}