import { KeyRound, Lock, ShieldQuestion } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ApiError } from "../lib/api.ts";
import { BackupError } from "../lib/crypto/index.ts";
import { GoogleButton } from "../components/GoogleButton.tsx";
import { LanguageToggle } from "../components/LanguageToggle.tsx";
import { Alert, Button, Card, Input, Label, PasswordInput, Spinner, cn } from "../components/ui.tsx";
import { useI18n } from "../i18n.tsx";
import { useSession } from "../session.tsx";

function messageOf(
  error: unknown,
  t: (key: string) => string,
): string {
  if (error instanceof BackupError) {
    return error.reason === "passphrase"
      ? t("error.backupPassphrase")
      : t("error.backupFormat");
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case "USERNAME_TAKEN":
        return t("error.usernameTaken");
      case "UNAUTHORIZED":
        return t("error.unauthorized");
      case "VALIDATION_ERROR":
        return t("error.validation");
      case "TOO_MANY_REQUESTS":
        return t("error.tooManyRequests");
      case "DEVICE_REQUIRED":
        return t("error.deviceRequired");
      case "BACKUP_NOT_FOUND":
        return t("error.backupNotFound");
      case "RECOVERY_UNAVAILABLE":
        return t("error.recoveryUnavailable");
      case "RECOVERY_CHALLENGE_INVALID":
        return t("error.recoveryChallengeInvalid");
      default:
        return error.message;
    }
  }
  if (error instanceof Error && /WebCrypto|subtle/i.test(error.message)) {
    return t("error.webcrypto");
  }
  return t("error.generic");
}

export function AuthPage() {
  const { login, register, recover, lastUsername, oauthEnabled, startGoogle, signupMode } =
    useSession();
  const { t } = useI18n();
  const [mode, setMode] = useState<"login" | "register" | "recover">("login");
  const [username, setUsername] = useState(lastUsername);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  /** 초대제(invite)에서만 사용하는 가입 코드. */
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (mode === "register" && password !== confirm) {
      setError(t("error.passwordMismatch"));
      return;
    }

    setBusy(true);
    try {
      if (mode === "login") await login(username, password);
      else if (mode === "register")
        await register(username, password, inviteCode.trim() || undefined);
      else await recover(username, password);
    } catch (caught) {
      if (
        mode === "recover" &&
        caught instanceof ApiError &&
        caught.status === 401
      ) {
        setError(t("error.recoverFailed"));
      } else {
        setError(messageOf(caught, t));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="auth-backdrop"
      className="min-h-dvh bg-gradient-to-br from-accent-50 via-white to-zinc-100 dark:from-accent-950 dark:via-zinc-950 dark:to-zinc-900"
    >
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
        <div className="mb-2 flex justify-end">
          <LanguageToggle />
        </div>
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-600 text-accent-contrast shadow-lg shadow-accent-600/20">
            <Lock className="h-6 w-6" aria-hidden />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">OneMoments</h1>
        </div>

        <Card className="p-6">
          <div
            className={cn(
              "mb-5 grid gap-1 rounded-lg bg-zinc-100 p-1",
              signupMode === "closed" ? "grid-cols-2" : "grid-cols-3",
            )}
          >
            {(
              [
                { value: "login", label: t("auth.tab.login") },
                ...(signupMode === "closed"
                  ? []
                  : [{ value: "register" as const, label: t("auth.tab.register") }]),
                { value: "recover", label: t("auth.tab.recover") },
              ] as const
            ).map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => {
                  setMode(item.value);
                  setError(null);
                }}
                className={
                  mode === item.value
                    ? "rounded-md bg-white px-3 py-2 text-sm font-medium text-zinc-900 shadow-sm"
                    : "rounded-md px-3 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-700"
                }
                aria-pressed={mode === item.value}
              >
                {item.label}
              </button>
            ))}
          </div>

          {oauthEnabled &&
          mode !== "recover" &&
          (mode !== "register" || signupMode === "open") ? (
            <div className="mb-5 space-y-3">
              <GoogleButton
                label={mode === "register" ? t("auth.google.signup") : t("auth.google.login")}
                disabled={busy}
                onClick={() => {
                  setError(null);
                  void startGoogle(mode === "register" ? "signup" : "login").catch(
                    (caught: unknown) => setError(messageOf(caught, t)),
                  );
                }}
              />
              <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                <span className="h-px flex-1 bg-zinc-200" />
                {t("auth.orContinue")}
                <span className="h-px flex-1 bg-zinc-200" />
              </div>
            </div>
          ) : null}

          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="username">{t("auth.username.label")}</Label>
              <Input
                id="username"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                minLength={3}
                maxLength={32}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="onemoment"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">
                {mode === "recover" ? t("auth.recoverPassphrase.label") : t("auth.password.label")}
              </Label>
              <PasswordInput
                id="password"
                name="password"
                autoComplete={
                  mode === "login" || mode === "recover"
                    ? "current-password"
                    : "new-password"
                }
                required
                minLength={mode === "login" ? 1 : 10}
                maxLength={200}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={
                  mode === "register"
                    ? t("auth.password.placeholder.min")
                    : mode === "recover"
                      ? t("auth.recoverPassphrase.placeholder")
                      : ""
                }
              />
            </div>

            {mode === "register" ? (
              <div className="space-y-1.5">
                <Label htmlFor="confirm">{t("auth.confirm.label")}</Label>
                <PasswordInput
                  id="confirm"
                  name="confirm"
                  autoComplete="new-password"
                  required
                  minLength={10}
                  maxLength={200}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </div>
            ) : null}

            {mode === "register" && signupMode === "invite" ? (
              <div className="space-y-1.5">
                <Label htmlFor="invite-code">초대 코드</Label>
                <Input
                  id="invite-code"
                  name="inviteCode"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  required
                  maxLength={32}
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                  placeholder="관리자에게 받은 코드"
                />
                <p className="text-[11px] text-zinc-400">
                  현재는 초대받은 사람만 가입할 수 있습니다.
                </p>
              </div>
            ) : null}

            {error ? <Alert variant="error">{error}</Alert> : null}

            {mode === "recover" ? (
              <p className="text-xs leading-relaxed text-zinc-500">
                {t("auth.recover.note")}
              </p>
            ) : null}

            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? (
                <Spinner />
              ) : mode === "recover" ? (
                <ShieldQuestion className="h-4 w-4" aria-hidden />
              ) : (
                <KeyRound className="h-4 w-4" aria-hidden />
              )}
              {mode === "login"
                ? t("auth.submit.login")
                : mode === "register"
                  ? t("auth.submit.register")
                  : t("auth.submit.recover")}
            </Button>
          </form>
        </Card>

        <p className="mt-5 text-center text-xs leading-relaxed text-zinc-500">
          {mode === "recover" ? t("auth.footer.recover") : t("auth.footer.default")}
        </p>
      </div>
    </div>
  );
}
