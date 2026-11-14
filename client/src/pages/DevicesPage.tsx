import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Laptop, ShieldCheck, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";

import { Alert, Button, Card, Spinner } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { useSession } from "../session.tsx";
import type { Device } from "../types.ts";

export function DevicesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();

  const devicesQuery = useQuery({
    queryKey: ["devices"],
    queryFn: () => api<{ devices: Device[] }>("/api/devices").then((response) => response.devices),
  });

  const revoke = useMutation({
    mutationFn: (deviceId: string) =>
      api(`/api/devices/${deviceId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
  });

  const devices = devicesQuery.data ?? [];

  return (
    <div className="min-h-dvh bg-zinc-50">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">
        <header className="flex items-center gap-3">
          <Link
            to="/"
            aria-label="대화로 돌아가기"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-lg font-semibold text-zinc-900">기기 관리</h1>
            <p className="text-xs text-zinc-500">
              기기 키는 각 브라우저에만 저장됩니다.
            </p>
          </div>
        </header>

        <Card className="divide-y divide-zinc-100">
          {devicesQuery.isLoading ? (
            <div className="flex justify-center p-8">
              <Spinner className="h-5 w-5 text-violet-600" />
            </div>
          ) : devicesQuery.isError ? (
            <div className="p-5">
              <Alert variant="error">기기 목록을 불러오지 못했습니다.</Alert>
            </div>
          ) : (
            devices.map((device) => {
              const current = device.id === session?.deviceId;
              const revoked = Boolean(device.revokedAt);
              return (
                <div key={device.id} className="flex items-center gap-3 p-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-100 text-zinc-600">
                    <Laptop className="h-5 w-5" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                      <span className="truncate">{device.name}</span>
                      {current ? (
                        <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                          현재 기기
                        </span>
                      ) : null}
                      {revoked ? (
                        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500">
                          폐기됨
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500">
                      <ShieldCheck className="h-3 w-3" aria-hidden />
                      {new Date(device.createdAt).toLocaleDateString("ko-KR")} 등록
                      {device.lastSeenAt
                        ? ` · 최근 접속 ${new Date(device.lastSeenAt).toLocaleDateString("ko-KR")}`
                        : ""}
                    </p>
                  </div>
                  {!current && !revoked ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={revoke.isPending}
                      onClick={() => {
                        if (window.confirm("이 기기를 폐기할까요? 해당 기기의 세션이 즉시 종료됩니다.")) {
                          revoke.mutate(device.id);
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      폐기
                    </Button>
                  ) : null}
                </div>
              );
            })
          )}
        </Card>

        {revoke.isError ? (
          <Alert variant="error">기기를 폐기하지 못했습니다.</Alert>
        ) : null}

        <p className="text-xs leading-relaxed text-zinc-500">
          새 기기에서 로그인하면 그 기기의 키가 새로 만들어집니다. 이전 대화는 그 키로
          복호화할 수 없으므로, 다른 기기에서 계속 확인해야 합니다.
        </p>
      </div>
    </div>
  );
}
