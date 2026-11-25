import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bell,
  BellOff,
  KeyRound,
  Laptop,
  Mic,
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
  Label,
  PasswordInput,
  Spinner,
} from "../components/ui.tsx";
import { useI18n } from "../i18n.tsx";
import { ApiError, api } from "../lib/api.ts";
import { currentPlatform, platformLabel } from "../lib/device.ts";
import {
  checkMicrophone,
  microphoneStatusLabel,
  type MicrophoneStatus,
} from "../lib/microphone.ts";
import {
  IDLE_TIMEOUT_OPTIONS,
  idleTimeoutLabel,
} from "../lib/idleTimeout.ts";
import { BackupError, exportKeyBackup, exportLocalCryptoState } from "../lib/crypto/index.ts";
import { clearDeviceState, deleteIdentity, deleteIdentityByUser } from "../lib/keystore.ts";
import { clearDeviceRecovered } from "../lib/recovery.ts";
import {
  currentPushSubscription,
  disablePush,
  enablePush,
  pushSupported,
  type PushState,
} from "../lib/push.ts";
import { useSession } from "../session.tsx";
import type { Device } from "../types.ts";
import { ThemeSettings } from "../components/ThemeSettings.tsx";
import { GoogleAccountSection } from "../components/GoogleAccountSection.tsx";

export function DevicesPage() {
  const { t, locale } = useI18n();
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
  const [micState, setMicState] = useState<"idle" | "checking" | MicrophoneStatus>(
    "idle",
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
        setPushMessage(t("devices.pushOff"));
      } else {
        await enablePush();
        setPushState("subscribed");
        setPushMessage(t("devices.pushOn"));
      }
    } catch (error) {
      setPushError(
        error instanceof Error ? error.message : t("devices.pushFailed"),
      );
    } finally {
      setPushBusy(false);
    }
  }

  async function checkMic(): Promise<void> {
    setMicState("checking");
    const status = await checkMicrophone();
    setMicState(status);
  }

  async function changeDeviceIdleTimeout(seconds: number): Promise<void> {
    setIdleBusy(true);
    setIdleError(null);
    setIdleMessage(null);
    try {
      await updateDeviceIdleTimeout(seconds);
      setIdleMessage(
        t("devices.idleDeviceSaved", { label: idleTimeoutLabel(seconds) }),
      );
    } catch (error) {
      setIdleError(
        error instanceof ApiError
          ? error.message
          : t("devices.idleDeviceFailed"),
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
        t("devices.idleSessionSaved", { label: idleTimeoutLabel(seconds) }),
      );
    } catch (error) {
      setIdleError(
        error instanceof ApiError
          ? error.message
          : t("devices.idleSessionFailed"),
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
          ? t("devices.idleSessionOnlySaved")
          : t("devices.idleSessionCleared"),
      );
    } catch (error) {
      setIdleError(
        error instanceof ApiError
          ? error.message
          : t("devices.idleSessionFailed"),
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
      setBackupError(t("devices.keyMissing"));
      return;
    }
    if (backupPassphrase.length < 10) {
      setBackupError(t("devices.passTooShort"));
      return;
    }
    if (backupPassphrase !== backupConfirm) {
      setBackupError(t("devices.passMismatch"));
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
        t("devices.backupSaved", { date: new Date(response.updatedAt).toLocaleString(locale === "en" ? "en-US" : "ko-KR") }),
      );
      setBackupPassphrase("");
      setBackupConfirm("");
      // 최신 백업에는 현재 세션 상태가 포함되므로 복구 안내를 해제한다.
      if (session) clearDeviceRecovered(session.deviceId);
      await queryClient.invalidateQueries({ queryKey: ["key-backup"] });
    } catch (error) {
      setBackupError(
        error instanceof BackupError
          ? error.reason === "format"
            ? t("devices.backupUnsupported")
            : t("devices.backupCreateFailed")
          : error instanceof ApiError
            ? error.status === 413
              ? t("devices.backupTooLarge")
              : error.message
            : t("devices.backupSaveFailed"),
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
          ? t("devices.wrongPassword")
          : t("devices.accountDeleteFailed"),
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
      clearDeviceRecovered(session.deviceId);
      await clearDeviceState(session.deviceId);
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
            aria-label={t("devices.back")}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-lg font-semibold text-zinc-900">{t("devices.title")}</h1>
            <p className="text-xs text-zinc-500">
              {t("devices.subtitle")}
            </p>
          </div>
        </header>

        <Card className="divide-y divide-zinc-100">
          {devicesQuery.isLoading ? (
            <div className="flex justify-center p-8">
              <Spinner className="h-5 w-5 text-accent-600" />
            </div>
          ) : devicesQuery.isError ? (
            <div className="p-5">
              <Alert variant="error">{t("devices.loadFailed")}</Alert>
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
                        <span className="rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-medium text-accent-700">
                          {t("devices.current")}
                        </span>
                      ) : null}
                      {revoked ? (
                        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500">
                          {t("devices.revoked")}
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500">
                      <ShieldCheck className="h-3 w-3" aria-hidden />
                      {platformLabel(device.platform)} ·{" "}
                      {t("devices.registeredAt", { date: new Date(device.createdAt).toLocaleDateString(locale === "en" ? "en-US" : "ko-KR") })}
                      {device.lastSeenAt
                        ? t("devices.lastSeenAt", { date: new Date(device.lastSeenAt).toLocaleDateString(locale === "en" ? "en-US" : "ko-KR") })
                        : ""}
                    </p>
                  </div>
                  {!current && !revoked ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={revoke.isPending}
                      onClick={() => {
                        if (window.confirm(t("devices.revokeConfirm"))) {
                          revoke.mutate(device.id);
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      {t("devices.revoke")}
                    </Button>
                  ) : null}
                </div>
              );
            })
          )}
        </Card>

        {revoke.isError ? (
          <Alert variant="error">{t("devices.revokeFailed")}</Alert>
        ) : null}

        <p className="text-xs leading-relaxed text-zinc-500">
          {t("devices.keyNote")}
        </p>

        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900">{t("devices.backupTitle")}</h2>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                {t("devices.backupNote")}
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-zinc-500">
              {lastBackupAt
                ? t("devices.lastBackup", { date: new Date(lastBackupAt).toLocaleDateString(locale === "en" ? "en-US" : "ko-KR") })
                : t("devices.noBackup")}
            </span>
          </div>

          <form className="mt-4 space-y-3" onSubmit={saveBackup}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="backup-passphrase">{t("devices.passphrase")}</Label>
                <PasswordInput
                  id="backup-passphrase"
                  autoComplete="new-password"
                  minLength={10}
                  value={backupPassphrase}
                  onChange={(event) => setBackupPassphrase(event.target.value)}
                  placeholder={t("devices.passphraseMin")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="backup-confirm">{t("devices.passphraseConfirm")}</Label>
                <PasswordInput
                  id="backup-confirm"
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
              {t("devices.saveBackup")}
            </Button>
          </form>

          <p className="mt-3 text-xs leading-relaxed text-zinc-500">
            {t("devices.backupWarning")}
          </p>
        </Card>

        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-900">{t("devices.pushTitle")}</h2>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                {t("devices.pushNote")}
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-zinc-500">
              {pushState === "loading"
                ? t("devices.checking")
                : pushState === "subscribed"
                  ? t("devices.on")
                  : pushState === "unsupported"
                    ? t("devices.unsupported")
                    : t("devices.off")}
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
              {t("devices.pushUnavailable")}
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
              {t(pushState === "subscribed" ? "devices.disablePush" : "devices.enablePush")}
            </Button>
          )}

          <p className="mt-3 text-xs leading-relaxed text-zinc-500">
            {t("devices.iosNote")}
          </p>
        </Card>

        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                <Mic className="h-4 w-4 text-zinc-500" aria-hidden />
                {t("devices.micTitle")}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                {t("devices.micNote")}
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-zinc-500">
              {platformLabel(currentPlatform())}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void checkMic()}
              disabled={micState === "checking"}
            >
              {micState === "checking" ? (
                <Spinner />
              ) : (
                <Mic className="h-4 w-4" aria-hidden />
              )}
              {t("devices.micTitle")}
            </Button>
            <span className="text-xs text-zinc-600" role="status">
              {micState === "idle"
                ? t("devices.micIdle")
                : micState === "checking"
                  ? t("devices.micChecking")
                  : microphoneStatusLabel(micState)}
            </span>
          </div>

          {micState === "denied" ? (
            <p className="mt-2 text-xs text-zinc-500">
              {t("devices.micDenied")}
            </p>
          ) : null}
          {micState === "insecure" ? (
            <p className="mt-2 text-xs text-zinc-500">
              {t("devices.micHttps")}
            </p>
          ) : null}
        </Card>

        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                <Timer className="h-4 w-4 text-zinc-500" aria-hidden />
                {t("devices.idleTitle")}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                {t("devices.idleNote")}
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-zinc-500">
              {t("devices.idleCurrent", { label: idleTimeoutLabel(idleTimeoutSeconds) })}
            </span>
          </div>

          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="device-idle-timeout">{t("devices.idleDeviceLabel")}</Label>
              <select
                id="device-idle-timeout"
                className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 focus:border-accent-400 focus:outline-none focus:ring-2 focus:ring-accent-100 disabled:opacity-50"
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
                {t("devices.idleDeviceNote")}
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-zinc-300 text-accent-600 focus:ring-accent-400"
                checked={sessionOverrideEnabled}
                disabled={idleBusy}
                onChange={(event) => void toggleSessionOverride(event.target.checked)}
              />
              {t("devices.idleUseSession")}
            </label>

            {sessionOverrideEnabled ? (
              <div className="space-y-1.5">
                <Label htmlFor="session-idle-timeout">{t("devices.idleSessionLabel")}</Label>
                <select
                  id="session-idle-timeout"
                  className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 focus:border-accent-400 focus:outline-none focus:ring-2 focus:ring-accent-100 disabled:opacity-50"
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
                  {t("devices.idleSessionNote")}
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

        <GoogleAccountSection />

        <Card className="p-5">
          <h2 className="text-sm font-semibold text-zinc-900">{t("devices.themeTitle")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            {t("devices.themeNote")}
          </p>
          <ThemeSettings />
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold text-zinc-900">{t("devices.keyTitle")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            {t("devices.keyNote2")}
          </p>
          <Button
            variant="destructive"
            size="sm"
            className="mt-3"
            onClick={() => setKeyDeleteOpen(true)}
          >
            <KeyRound className="h-4 w-4" aria-hidden />
            {t("devices.deleteKey")}
          </Button>
        </Card>

        <Card className="border-red-200 p-5">
          <h2 className="text-sm font-semibold text-zinc-900">{t("devices.accountTitle")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            {t("devices.accountNote")}
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
            {t("devices.accountTitle")}
          </Button>
        </Card>
      </div>

      <Dialog
        open={keyDeleteOpen}
        onClose={() => setKeyDeleteOpen(false)}
        title={t("devices.deleteKey")}
      >
        <p className="text-sm leading-relaxed text-zinc-600">
          {t("devices.deleteKeyNote")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setKeyDeleteOpen(false)}>
            {t("chat.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => void deleteLocalKeys()}>
            <Trash2 className="h-4 w-4" aria-hidden />
            {t("devices.deleteAndSignOut")}
          </Button>
        </div>
      </Dialog>

      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} title={t("devices.accountTitle")}>
        <form className="space-y-3" onSubmit={confirmAccountDeletion}>
          <p className="text-sm leading-relaxed text-zinc-600">
            {t("devices.accountNoteShort")}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="delete-account-password">{t("devices.passwordConfirm")}</Label>
            <PasswordInput
              id="delete-account-password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {deleteError ? <Alert variant="error">{deleteError}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setDeleteOpen(false)}>
              {t("chat.cancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={deleting}>
              {deleting ? <Spinner /> : <Trash2 className="h-4 w-4" aria-hidden />}
              {t("devices.deleteAccount")}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
