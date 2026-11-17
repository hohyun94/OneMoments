import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bell,
  BellOff,
  KeyRound,
  Laptop,
  ShieldCheck,
  Timer,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
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
import {
  IDLE_TIMEOUT_OPTIONS,
  idleTimeoutLabel,
} from "../lib/idleTimeout.ts";
import { BackupError, exportKeyBackup, exportLocalCryptoState } from "../lib/crypto/index.ts";
import { deleteIdentity, deleteIdentityByUser } from "../lib/keystore.ts";
import {
  currentPushSubscription,
  disablePush,
  enablePush,
  pushSupported,
  type PushState,
} from "../lib/push.ts";
import { useSession } from "../session.tsx";
import type { Device } from "../types.ts";

export function DevicesPage() {
  const {
    session,
    identity,
    logout,
    idleTimeoutSeconds,
    deviceIdleTimeoutSeconds,
    sessionIdleTimeoutSeconds,
    updateDeviceIdleTimeout,
    updateSessionIdleTimeout,
  } = useSession();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [keyDeleteOpen, setKeyDeleteOpen] = useState(false);
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupConfirm, setBackupConfirm] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<PushState | "loading">("loading");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const [idleBusy, setIdleBusy] = useState(false);
  const [idleMessage, setIdleMessage] = useState<string | null>(null);
  const [idleError, setIdleError] = useState<string | null>(null);
  const [sessionOverrideEnabled, setSessionOverrideEnabled] = useState(
    sessionIdleTimeoutSeconds !== null,
  );

  // 다른 곳(예: 재로그인)에서 세션 오버라이드가 바뀌면 체크박스를 동기화한다.
  useEffect(() => {
    setSessionOverrideEnabled(sessionIdleTimeoutSeconds !== null);
  }, [sessionIdleTimeoutSeconds]);

  useEffect(() => {
    let cancelled = false;
    if (!pushSupported()) {
      setPushState("unsupported");
      return;
    }
    void currentPushSubscription()
      .then((subscription) => {
        if (!cancelled) setPushState(subscription ? "subscribed" : "unsubscribed");
      })
      .catch(() => {
        if (!cancelled) setPushState("unsubscribed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function togglePush(): Promise<void> {
    setPushBusy(true);
    setPushError(null);
    setPushMessage(null);
    try {
      if (pushState === "subscribed") {
        await disablePush();
        setPushState("unsubscribed");
        setPushMessage("알림을 껐습니다.");
      } else {
        await enablePush();
        setPushState("subscribed");
        setPushMessage("알림을 켰습니다. 새 메시지가 오면 브라우저 알림으로 알려드립니다.");
      }
    } catch (error) {
      setPushError(
        error instanceof Error ? error.message : "알림 설정을 변경하지 못했습니다.",
      );
    } finally {
      setPushBusy(false);
    }
  }

  async function changeDeviceIdleTimeout(seconds: number): Promise<void> {
    setIdleBusy(true);
    setIdleError(null);
    setIdleMessage(null);
    try {
      await updateDeviceIdleTimeout(seconds);
      setIdleMessage(
        `이 기기의 기본 자동 로그아웃을 ${idleTimeoutLabel(seconds)}로 저장했습니다.`,
      );
    } catch (error) {
      setIdleError(
        error instanceof ApiError
          ? error.message
          : "자동 로그아웃 설정을 변경하지 못했습니다.",
      );
    } finally {
      setIdleBusy(false);
    }
  }

  async function changeSessionIdleTimeout(seconds: number): Promise<void> {
    setIdleBusy(true);
    setIdleError(null);
    setIdleMessage(null);
    try {
      await updateSessionIdleTimeout(seconds);
      setIdleMessage(
        `이번 로그인에만 ${idleTimeoutLabel(seconds)} 자동 로그아웃을 적용합니다.`,
      );
    } catch (error) {
      setIdleError(
        error instanceof ApiError
          ? error.message
          : "세션 자동 로그아웃 설정을 변경하지 못했습니다.",
      );
    } finally {
      setIdleBusy(false);
    }
  }

  async function toggleSessionOverride(enabled: boolean): Promise<void> {
    setIdleBusy(true);
    setIdleError(null);
    setIdleMessage(null);
    try {
      await updateSessionIdleTimeout(
        enabled ? (sessionIdleTimeoutSeconds ?? deviceIdleTimeoutSeconds) : null,
      );
      setSessionOverrideEnabled(enabled);
      setIdleMessage(
        enabled
          ? "이번 로그인에만 적용할 자동 로그아웃 시간을 저장했습니다."
          : "세션 전용 설정을 해제하고 기기 기본값을 사용합니다.",
      );
    } catch (error) {
      setIdleError(
        error instanceof ApiError
          ? error.message
          : "세션 자동 로그아웃 설정을 변경하지 못했습니다.",
      );
    } finally {
      setIdleBusy(false);
    }
  }

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

  // 서버가 허용하는 임의 값(60~1800초)도 목록에 표시되도록 현재 값들을 합친다.
  const timeoutOptions = [
    ...new Set([
      ...IDLE_TIMEOUT_OPTIONS.map((option) => option.seconds),
      deviceIdleTimeoutSeconds,
      ...(sessionIdleTimeoutSeconds !== null ? [sessionIdleTimeoutSeconds] : []),
    ]),
  ]
    .sort((a, b) => a - b)
    .map((seconds) => ({ seconds, label: idleTimeoutLabel(seconds) }));

  const backupQuery = useQuery({
    queryKey: ["key-backup"],
    queryFn: async () => {
      try {
        return await api<{ backup: { blob: string; updatedAt: string } }>(
          "/api/auth/backup",
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
  const lastBackupAt = backupQuery.data?.backup.updatedAt ?? null;

  async function saveBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBackupError(null);
    setBackupMessage(null);

    if (!identity) {
      setBackupError("이 기기의 키를 찾을 수 없습니다. 다시 로그인해 주세요.");
      return;
    }
    if (backupPassphrase.length < 10) {
      setBackupError("복구 암호는 10자 이상이어야 합니다.");
      return;
    }
    if (backupPassphrase !== backupConfirm) {
      setBackupError("복구 암호가 서로 다릅니다.");
      return;
    }

    setBackupBusy(true);
    try {
      const state =
        identity.deviceId ? await exportLocalCryptoState(identity.deviceId) : undefined;
      const blob = await exportKeyBackup(identity, backupPassphrase, state);
      const response = await api<{ updatedAt: string }>("/api/auth/backup", {
        method: "PUT",
        rawBody: new Blob([JSON.stringify(blob)], { type: "text/plain" }),
      });
      setBackupMessage(
        `백업이 저장되었습니다 (${new Date(response.updatedAt).toLocaleString("ko-KR")})`,
      );
      setBackupPassphrase("");
      setBackupConfirm("");
      await queryClient.invalidateQueries({ queryKey: ["key-backup"] });
    } catch (error) {
      setBackupError(
        error instanceof BackupError
          ? error.reason === "format"
            ? "이 기기의 키는 백업을 지원하지 않습니다(이전 버전 키). 새 기기에서 다시 로그인해 주세요."
            : "백업을 만들 수 없습니다."
          : error instanceof ApiError
            ? error.status === 413
              ? "백업 데이터가 너무 큽니다. 기기 관리에서 다시 백업하거나 관리자에게 문의하세요."
              : error.message
            : "백업을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
    } finally {
      setBackupBusy(false);
    }
  }

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
      await deleteIdentityByUser(session.user.id);
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
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900">키 백업</h2>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                복구 암호로 이 기기의 키를 암호화해 서버에 저장합니다. 복구 암호는
                서버로 전송되지 않으며, 새 브라우저의 로그인 화면 → 복구 탭에서 이
                백업으로 대화 이력을 이어갈 수 있습니다.
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-zinc-500">
              {lastBackupAt
                ? `마지막 백업 ${new Date(lastBackupAt).toLocaleDateString("ko-KR")}`
                : "백업 없음"}
            </span>
          </div>

          <form className="mt-4 space-y-3" onSubmit={saveBackup}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="backup-passphrase">복구 암호</Label>
                <Input
                  id="backup-passphrase"
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  value={backupPassphrase}
                  onChange={(event) => setBackupPassphrase(event.target.value)}
                  placeholder="10자 이상"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="backup-confirm">복구 암호 확인</Label>
                <Input
                  id="backup-confirm"
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  value={backupConfirm}
                  onChange={(event) => setBackupConfirm(event.target.value)}
                />
              </div>
            </div>

            {backupError ? <Alert variant="error">{backupError}</Alert> : null}
            {backupMessage ? <Alert>{backupMessage}</Alert> : null}

            <Button type="submit" size="sm" disabled={backupBusy}>
              {backupBusy ? <Spinner /> : <KeyRound className="h-4 w-4" aria-hidden />}
              백업 저장
            </Button>
          </form>

          <p className="mt-3 text-xs leading-relaxed text-zinc-500">
            복구 암호를 잊으면 백업을 복원할 수 없습니다. 백업을 갱신하면 이전 백업은
            덮어써집니다.
          </p>
        </Card>

        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900">알림</h2>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                새 메시지가 도착하면 브라우저 알림으로 알려줍니다. 알림에는 대화 ID만
                포함되고 메시지 내용·발신자·파일 정보는 서버 푸시에 담기지 않습니다.
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-zinc-500">
              {pushState === "loading"
                ? "확인 중"
                : pushState === "subscribed"
                  ? "켜짐"
                  : pushState === "unsupported"
                    ? "미지원"
                    : "꺼짐"}
            </span>
          </div>

          {pushError ? (
            <div className="mt-3">
              <Alert variant="error">{pushError}</Alert>
            </div>
          ) : null}
          {pushMessage ? (
            <div className="mt-3">
              <Alert>{pushMessage}</Alert>
            </div>
          ) : null}

          {pushState === "unsupported" ? (
            <p className="mt-3 text-xs text-zinc-500">
              이 브라우저에서는 푸시 알림을 사용할 수 없습니다. HTTPS(또는 localhost)에서
              다시 시도해 주세요.
            </p>
          ) : (
            <Button
              variant={pushState === "subscribed" ? "outline" : "default"}
              size="sm"
              className="mt-3"
              onClick={() => void togglePush()}
              disabled={pushBusy || pushState === "loading"}
            >
              {pushBusy ? (
                <Spinner />
              ) : pushState === "subscribed" ? (
                <BellOff className="h-4 w-4" aria-hidden />
              ) : (
                <Bell className="h-4 w-4" aria-hidden />
              )}
              {pushState === "subscribed" ? "알림 끄기" : "알림 켜기"}
            </Button>
          )}

          <p className="mt-3 text-xs leading-relaxed text-zinc-500">
            iOS는 홈 화면에 추가한 PWA에서만 Web Push를 지원합니다. 알림 권한은
            브라우저 사이트 설정에서 언제든지 해제할 수 있습니다.
          </p>
        </Card>

        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                <Timer className="h-4 w-4 text-zinc-500" aria-hidden />
                자동 로그아웃
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                무활동이 이어지면 자동으로 로그아웃해 화면의 대화 내용을 지웁니다. 기기
                기본값과 이번 로그인에만 적용할 값을 따로 둘 수 있으며, 1~30분 범위에서만
                설정할 수 있습니다(끄기 불가).
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-zinc-500">
              현재 {idleTimeoutLabel(idleTimeoutSeconds)}
            </span>
          </div>

          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="device-idle-timeout">이 기기 기본값</Label>
              <select
                id="device-idle-timeout"
                className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100 disabled:opacity-50"
                value={deviceIdleTimeoutSeconds}
                disabled={idleBusy}
                onChange={(event) => void changeDeviceIdleTimeout(Number(event.target.value))}
              >
                {timeoutOptions.map((option) => (
                  <option key={option.seconds} value={option.seconds}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs leading-relaxed text-zinc-500">
                같은 기기에서 다시 로그인해도 유지됩니다. 세션 설정이 있으면 세션 설정이
                우선합니다.
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-zinc-300 text-violet-600 focus:ring-violet-400"
                checked={sessionOverrideEnabled}
                disabled={idleBusy}
                onChange={(event) => void toggleSessionOverride(event.target.checked)}
              />
              이번 로그인에만 다른 값 적용
            </label>

            {sessionOverrideEnabled ? (
              <div className="space-y-1.5">
                <Label htmlFor="session-idle-timeout">이번 로그인</Label>
                <select
                  id="session-idle-timeout"
                  className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100 disabled:opacity-50"
                  value={sessionIdleTimeoutSeconds ?? idleTimeoutSeconds}
                  disabled={idleBusy}
                  onChange={(event) =>
                    void changeSessionIdleTimeout(Number(event.target.value))
                  }
                >
                  {timeoutOptions.map((option) => (
                    <option key={option.seconds} value={option.seconds}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs leading-relaxed text-zinc-500">
                  로그아웃하거나 다시 로그인하면 세션 설정은 사라지고 기기 기본값으로
                  돌아갑니다.
                </p>
              </div>
            ) : null}
          </div>

          {idleError ? (
            <div className="mt-3">
              <Alert variant="error">{idleError}</Alert>
            </div>
          ) : null}
          {idleMessage ? (
            <div className="mt-3">
              <Alert>{idleMessage}</Alert>
            </div>
          ) : null}
        </Card>

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
