import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, KeyRound, Laptop, ShieldCheck, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import {
  Alert,
  Button,
  Card,
  Dialog,
  Input,
  Label,
  Spinner,
} from "../components/ui.tsx";
import { ApiError, api } from "../lib/api.ts";
import { deleteIdentity } from "../lib/keystore.ts";
import { useSession } from "../session.tsx";
import type { Device } from "../types.ts";

export function DevicesPage() {
  const { session, logout } = useSession();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [keyDeleteOpen, setKeyDeleteOpen] = useState(false);

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

  async function confirmAccountDeletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDeleting(true);
    setDeleteError(null);
    try {
      await api("/api/auth/account", { method: "DELETE", body: { password } });
      await logout();
    } catch (error) {
      setDeleteError(
        error instanceof ApiError && error.status === 401
          ? "비밀번호가 올바르지 않습니다."
          : "계정을 삭제할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      );
    } finally {
      setDeleting(false);
    }
  }

  async function deleteLocalKeys() {
    if (!session) return;
    try {
      // 서버 기기 폐기(세션 무효) + 로컬 키 삭제. 실패해도 로그아웃은 진행한다.
      await api(`/api/devices/${session.deviceId}`, { method: "DELETE" }).catch(
        () => undefined,
      );
      await deleteIdentity(session.user.username);
    } finally {
      await logout();
    }
  }

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

        <Card className="p-5">
          <h2 className="text-sm font-semibold text-zinc-900">이 기기 키</h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            이 브라우저에 저장된 기기 키를 삭제하고 로그아웃합니다. 삭제 후에는 이
            기기에서 과거 대화를 복호화할 수 없습니다.
          </p>
          <Button
            variant="destructive"
            size="sm"
            className="mt-3"
            onClick={() => setKeyDeleteOpen(true)}
          >
            <KeyRound className="h-4 w-4" aria-hidden />
            이 기기에서 키 삭제
          </Button>
        </Card>

        <Card className="border-red-200 p-5">
          <h2 className="text-sm font-semibold text-zinc-900">계정 삭제</h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            계정을 삭제하면 로그인·기기·세션이 무효화되고 계정이 익명화됩니다. 상대의
            대화 이력에는 내 메시지가 &quot;삭제된 사용자&quot;로 남으며, username은
            재사용할 수 없습니다.
          </p>
          <Button
            variant="destructive"
            size="sm"
            className="mt-3"
            onClick={() => {
              setPassword("");
              setDeleteError(null);
              setDeleteOpen(true);
            }}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            계정 삭제
          </Button>
        </Card>
      </div>

      <Dialog
        open={keyDeleteOpen}
        onClose={() => setKeyDeleteOpen(false)}
        title="이 기기에서 키 삭제"
      >
        <p className="text-sm leading-relaxed text-zinc-600">
          이 기기의 비밀키를 삭제하고 로그아웃합니다. 같은 계정으로 다시 로그인하면 새
          기기 키가 만들어지며, 과거 메시지는 복호화되지 않습니다.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setKeyDeleteOpen(false)}>
            취소
          </Button>
          <Button variant="destructive" onClick={() => void deleteLocalKeys()}>
            <Trash2 className="h-4 w-4" aria-hidden />
            삭제하고 로그아웃
          </Button>
        </div>
      </Dialog>

      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} title="계정 삭제">
        <form className="space-y-3" onSubmit={confirmAccountDeletion}>
          <p className="text-sm leading-relaxed text-zinc-600">
            계정을 삭제하면 로그인·기기·세션이 무효화되고 계정이 익명화됩니다. 상대의
            대화 이력에는 내 메시지가 &quot;삭제된 사용자&quot;로 남습니다. 이 작업은
            되돌릴 수 없습니다.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="delete-account-password">비밀번호 확인</Label>
            <Input
              id="delete-account-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {deleteError ? <Alert variant="error">{deleteError}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setDeleteOpen(false)}>
              취소
            </Button>
            <Button type="submit" variant="destructive" disabled={deleting}>
              {deleting ? <Spinner /> : <Trash2 className="h-4 w-4" aria-hidden />}
              계정 삭제
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
