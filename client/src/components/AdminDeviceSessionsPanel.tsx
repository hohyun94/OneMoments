import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useState } from "react";

import { Alert, Button, Card, Dialog, Spinner } from "./ui.tsx";
import { api } from "../lib/api.ts";
import { useI18n } from "../i18n.tsx";
import type { AdminDeviceSessions } from "../types.ts";

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
 * 기기 상세 + 세션 목록 패널.
 * 세션 토큰·기기 키는 서버가 응답하지 않으며, 메타데이터만 표시한다.
 */
export function AdminDeviceSessionsPanel({
  deviceId,
  onClose,
}: {
  deviceId: string;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: ["admin", "device-sessions", deviceId],
    queryFn: () => api<AdminDeviceSessions>(`/api/admin/devices/${deviceId}/sessions`),
  });

  const revoke = useMutation({
    mutationFn: () =>
      api<{ revokedSessions: number }>(`/api/admin/devices/${deviceId}/revoke-sessions`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      setConfirmOpen(false);
      setNotice(t("admin.sessionsRevoked", { count: result.revokedSessions }));
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
  });

  if (sessionsQuery.isLoading) {
    return (
      <Card className="p-4">
        <div className="flex justify-center py-6">
          <Spinner className="h-5 w-5 text-accent-600" />
        </div>
      </Card>
    );
  }
  if (sessionsQuery.isError) {
    return (
      <Card className="p-4">
        <Alert variant="error">{t(errorMessage(sessionsQuery.error))}</Alert>
        <div className="mt-3 flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("admin.close")}
          </Button>
        </div>
      </Card>
    );
  }
  const data = sessionsQuery.data;
  if (!data) return null;

  const now = Date.now();
  const activeCount = data.sessions.filter(
    (session) => new Date(session.expiresAt).getTime() > now,
  ).length;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-900">{data.device.name}</p>
          <p className="text-xs text-zinc-500">
            {t("admin.sessions.deviceHeader", {
              username: data.device.username,
              active: activeCount,
              total: data.sessions.length,
            })}
            {data.device.revokedAt ? t("admin.sessions.deviceRevoked") : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t("admin.close")}
        </Button>
        {data.device.revokedAt ? null : (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={data.sessions.length === 0 || revoke.isPending}
          >
            <KeyRound className="h-4 w-4" aria-hidden />
            {t("admin.sessions.revokeAll")}
          </Button>
        )}
      </div>

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

      {data.sessions.length > 0 ? (
        <ul className="mt-4 divide-y divide-zinc-100 border-t border-zinc-100">
          {data.sessions.map((session) => {
            const expired = new Date(session.expiresAt).getTime() <= now;
            return (
              <li key={session.id} className="py-2">
                <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span className="font-medium text-zinc-700">{t("admin.sessions.label", { id: session.id.slice(0, 8) })}</span>
                  {expired ? (
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                      {t("admin.sessions.expiresShort")}
                    </span>
                  ) : (
                    <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                      {t("admin.sessions.active")}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {t("admin.sessions.meta", {
                    created: formatDateTime(session.createdAt, locale),
                    lastSeen: formatDateTime(session.lastSeenAt, locale),
                    expires: formatDateTime(session.expiresAt, locale),
                  })}
                </p>
                <p className="mt-0.5 truncate text-xs text-zinc-400">
                  {session.userAgent ?? t("admin.sessions.noUserAgent")}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-4 border-t border-zinc-100 pt-4 text-sm text-zinc-500">
          {t("admin.sessions.empty")}
        </p>
      )}

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} title={t("admin.sessions.revokeAllTitle")}>
        <p className="text-sm leading-relaxed text-zinc-600">
          {t("admin.sessions.revokeAllNote", {
            username: data.device.username,
            name: data.device.name,
          })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => setConfirmOpen(false)}
            disabled={revoke.isPending}
          >
            {t("admin.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => revoke.mutate()}
            disabled={revoke.isPending}
          >
            {revoke.isPending ? t("admin.sessions.revoking") : t("admin.revoke")}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}