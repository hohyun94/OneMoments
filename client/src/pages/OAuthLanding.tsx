/**
 * Google OAuth 복귀 화면(`/oauth/callback`).
 * 서버가 넘긴 1회용 티켓으로 가입 아이디 선택, 로그인, 계정 연결을 마무리한다.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useI18n } from "../i18n.tsx";
import { ApiError } from "../lib/api.ts";
import { Alert, Button, Card, Input, Label, Spinner } from "../components/ui.tsx";
import { useSession } from "../session.tsx";

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "oauth.error.accessDenied",
  invalid_request: "oauth.error.invalidRequest",
  state_mismatch: "oauth.error.stateMismatch",
  state_expired: "oauth.error.stateExpired",
  provider_error: "oauth.error.provider",
  email_unverified: "oauth.error.emailUnverified",
  not_linked: "oauth.error.notLinked",
  already_linked: "oauth.error.alreadyLinked",
};

function messageOf(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "USERNAME_TAKEN":
        return t("error.usernameTaken");
      case "USERNAME_REQUIRED":
        return t("oauth.error.usernameRequired");
      case "OAUTH_TICKET_INVALID":
        return t("oauth.error.ticketExpired");
      case "VALIDATION_ERROR":
        return t("oauth.error.usernameInvalid");
      case "OAUTH_DISABLED":
        return t("oauth.error.disabled");
      default:
        return error.message;
    }
  }
  return t("oauth.error.generic");
}

export function OAuthLanding() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { status, completeGoogle, completeGoogleLink, googleLinked } = useSession();
  const params = new URLSearchParams(window.location.search);
  const ticket = params.get("oauth_ticket");
  const intent = params.get("oauth_intent");
  const errorCode = params.get("oauth_error");

  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(
    errorCode ? t(OAUTH_ERROR_MESSAGES[errorCode] ?? "oauth.error.generic") : null,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ticket || intent !== "login") return;
    if (status === "authenticated") {
      navigate("/", { replace: true });
      return;
    }
    if (status !== "anonymous") return;
    setBusy(true);
    completeGoogle({ ticket })
      .then(() => navigate("/", { replace: true }))
      .catch((caught: unknown) => setError(messageOf(caught, t)))
      .finally(() => setBusy(false));
  }, [ticket, intent, status, completeGoogle, navigate]);

  useEffect(() => {
    if (!ticket || intent !== "link") return;
    if (status === "loading") return;
    if (status !== "authenticated") {
      setError(t("oauth.error.loginFirst"));
      return;
    }
    setBusy(true);
    completeGoogleLink(ticket)
      .then(() => navigate("/devices", { replace: true }))
      .catch((caught: unknown) => setError(messageOf(caught, t)))
      .finally(() => setBusy(false));
  }, [ticket, intent, status, completeGoogleLink, navigate]);

  async function finishSignup(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ticket) return;
    setBusy(true);
    setError(null);
    try {
      await completeGoogle({ ticket, username });
      navigate("/", { replace: true });
    } catch (caught) {
      setError(messageOf(caught, t));
    } finally {
      setBusy(false);
    }
  }

  const needsUsername = Boolean(ticket) && intent === "signup" && !error;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4">
      <Card className="w-full max-w-md p-6">
        <h1 className="text-lg font-semibold text-zinc-900">
          {t(needsUsername ? "oauth.titleUsername" : "oauth.titleLogin")}
        </h1>

        {needsUsername ? (
          <>
            <p className="mt-2 text-sm leading-relaxed text-zinc-500">
              {t("oauth.usernameNote")}
              {t("oauth.keysLocal")}
            </p>
            <form className="mt-4 space-y-4" onSubmit={(event) => void finishSignup(event)}>
              <div className="space-y-1.5">
                <Label htmlFor="oauth-username">{t("oauth.usernameLabel")}</Label>
                <Input
                  id="oauth-username"
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
              {error ? <Alert variant="error">{error}</Alert> : null}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? <Spinner /> : null}
                {t("oauth.finish")}
              </Button>
            </form>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm leading-relaxed text-zinc-500">
              {busy
                ? intent === "link"
                  ? t("oauth.linking")
                  : t("oauth.finishing")
                : googleLinked
                  ? t("oauth.linked")
                  : t("oauth.verified")}
            </p>
            {busy ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-zinc-500">
                <Spinner /> {t("oauth.wait")}
              </div>
            ) : null}
            {error ? (
              <div className="mt-4">
                <Alert variant="error">{error}</Alert>
              </div>
            ) : null}
          </>
        )}

        {!busy && (error || !needsUsername) ? (
          <p className="mt-5 text-center text-xs text-zinc-500">
            <Link to="/" className="underline hover:text-zinc-700">
              {t("oauth.back")}
            </Link>
          </p>
        ) : null}
      </Card>
    </div>
  );
}
