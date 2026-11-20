/**
 * Google OAuth 복귀 화면(`/oauth/callback`).
 * 서버가 넘긴 1회용 티켓으로 가입 아이디 선택, 로그인, 계정 연결을 마무리한다.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { ApiError } from "../lib/api.ts";
import { Alert, Button, Card, Input, Label, Spinner } from "../components/ui.tsx";
import { useSession } from "../session.tsx";

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Google 로그인을 취소했습니다.",
  invalid_request: "로그인 요청이 올바르지 않습니다. 다시 시도해 주세요.",
  state_mismatch: "로그인 요청이 만료되었거나 위조되었습니다. 다시 시도해 주세요.",
  state_expired: "로그인 요청이 만료되었습니다. 다시 시도해 주세요.",
  provider_error: "Google 인증에 실패했습니다. 잠시 후 다시 시도해 주세요.",
  email_unverified: "Google 이메일 인증이 필요합니다.",
  not_linked: "이 Google 계정은 연결된 계정이 없습니다. 먼저 가입하거나 계정에 연결해 주세요.",
  already_linked: "이 Google 계정은 이미 다른 계정에 연결되어 있습니다.",
};

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "USERNAME_TAKEN":
        return "이미 사용 중인 아이디입니다.";
      case "USERNAME_REQUIRED":
        return "아이디를 입력해 주세요.";
      case "OAUTH_TICKET_INVALID":
        return "인증 요청이 만료되었습니다. 다시 시도해 주세요.";
      case "VALIDATION_ERROR":
        return "아이디는 3~32자(영문·숫자·. _ -)로 입력해 주세요.";
      case "OAUTH_DISABLED":
        return "이 서버에서는 Google 로그인을 사용할 수 없습니다.";
      default:
        return error.message;
    }
  }
  return "Google 로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.";
}

export function OAuthLanding() {
  const navigate = useNavigate();
  const { status, completeGoogle, completeGoogleLink, googleLinked } = useSession();
  const params = new URLSearchParams(window.location.search);
  const ticket = params.get("oauth_ticket");
  const intent = params.get("oauth_intent");
  const errorCode = params.get("oauth_error");

  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(
    errorCode ? (OAUTH_ERROR_MESSAGES[errorCode] ?? "Google 로그인에 실패했습니다.") : null,
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
      .catch((caught: unknown) => setError(messageOf(caught)))
      .finally(() => setBusy(false));
  }, [ticket, intent, status, completeGoogle, navigate]);

  useEffect(() => {
    if (!ticket || intent !== "link") return;
    if (status === "loading") return;
    if (status !== "authenticated") {
      setError("로그인한 뒤에 Google 계정을 연결할 수 있습니다.");
      return;
    }
    setBusy(true);
    completeGoogleLink(ticket)
      .then(() => navigate("/devices", { replace: true }))
      .catch((caught: unknown) => setError(messageOf(caught)))
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
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  const needsUsername = Boolean(ticket) && intent === "signup" && !error;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4">
      <Card className="w-full max-w-md p-6">
        <h1 className="text-lg font-semibold text-zinc-900">
          {needsUsername ? "아이디 선택" : "Google 로그인"}
        </h1>

        {needsUsername ? (
          <>
            <p className="mt-2 text-sm leading-relaxed text-zinc-500">
              Google 인증이 끝났습니다. OneMoments 에서 사용할 아이디를 정해 주세요.
              기기 키는 이 브라우저에만 만들어집니다.
            </p>
            <form className="mt-4 space-y-4" onSubmit={(event) => void finishSignup(event)}>
              <div className="space-y-1.5">
                <Label htmlFor="oauth-username">아이디</Label>
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
                가입 완료
              </Button>
            </form>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm leading-relaxed text-zinc-500">
              {busy
                ? intent === "link"
                  ? "Google 계정을 연결하는 중입니다…"
                  : "Google 로그인을 마무리하는 중입니다…"
                : googleLinked
                  ? "Google 계정이 연결되어 있습니다."
                  : "Google 인증 결과를 확인했습니다."}
            </p>
            {busy ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-zinc-500">
                <Spinner /> 잠시만 기다려 주세요.
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
              로그인 화면으로 돌아가기
            </Link>
          </p>
        ) : null}
      </Card>
    </div>
  );
}
