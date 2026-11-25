import { useI18n } from "../i18n.tsx";
import { ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ApiError } from "../lib/api.ts";
import { useSession } from "../session.tsx";
import { Alert, Button, Card, Label, PasswordInput, Spinner } from "./ui.tsx";

type Translate = (key: string) => string;

function messageOf(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "PASSWORD_REQUIRED":
        return t("google.unlinkNeedsPassword");
      case "OAUTH_NOT_LINKED":
        return t("google.notLinked");
      case "UNAUTHORIZED":
        return t("google.wrongPassword");
      case "OAUTH_DISABLED":
        return t("oauth.error.disabled");
      default:
        return error.message;
    }
  }
  return t("google.requestFailed");
}

/** 기기 설정의 {t("google.title")} 연결/해제 카드. */
export function GoogleAccountSection() {
  const { t } = useI18n();
  const { oauthEnabled, googleLinked, hasPassword, startGoogleLink, unlinkGoogle } = useSession();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!oauthEnabled) return null;

  async function link(): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await startGoogleLink();
    } catch (caught) {
      setError(messageOf(caught, t));
    } finally {
      setBusy(false);
    }
  }

  async function unlink(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await unlinkGoogle(password);
      setPassword("");
      setMessage(t("google.unlinked"));
    } catch (caught) {
      setError(messageOf(caught, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
        <ShieldCheck className="h-4 w-4 text-accent-600" aria-hidden />
        {t("google.title")}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        {t("google.note")}
      </p>

      {googleLinked ? (
        <>
          <p className="mt-3 text-sm text-zinc-700">{t("google.currentlyLinked")}</p>
          {hasPassword ? (
            <form className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(event) => void unlink(event)}>
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="google-unlink-password">{t("google.passwordConfirm")}</Label>
                <PasswordInput
                  id="google-unlink-password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={t("google.passwordPlaceholder")}
                />
              </div>
              <Button type="submit" variant="outline" disabled={busy || password.length === 0}>
                {busy ? <Spinner /> : null}
                {t("google.unlink")}
              </Button>
            </form>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-amber-600">
              {t("google.unlinkNote")}
            </p>
          )}
        </>
      ) : (
        <Button variant="outline" size="sm" className="mt-3" disabled={busy} onClick={() => void link()}>
          {busy ? <Spinner /> : null}
          {t("google.link")}
        </Button>
      )}

      {message ? (
        <div className="mt-3">
          <Alert>{message}</Alert>
        </div>
      ) : null}
      {error ? (
        <div className="mt-3">
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}
