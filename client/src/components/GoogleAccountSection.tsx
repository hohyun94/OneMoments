import { ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ApiError } from "../lib/api.ts";
import { useSession } from "../session.tsx";
import { Alert, Button, Card, Label, PasswordInput, Spinner } from "./ui.tsx";

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "PASSWORD_REQUIRED":
        return "비밀번호가 없는 계정은 연결을 해제할 수 없습니다.";
      case "OAUTH_NOT_LINKED":
        return "연결된 Google 계정이 없습니다.";
      case "UNAUTHORIZED":
        return "비밀번호가 올바르지 않습니다.";
      case "OAUTH_DISABLED":
        return "이 서버에서는 Google 로그인을 사용할 수 없습니다.";
      default:
        return error.message;
    }
  }
  return "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

/** 기기 설정의 Google 계정 연결/해제 카드. */
export function GoogleAccountSection() {
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
      setError(messageOf(caught));
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
      setMessage("Google 연결을 해제했습니다.");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
        <ShieldCheck className="h-4 w-4 text-accent-600" aria-hidden />
        Google 계정
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        연결하면 다음부터 비밀번호 없이 Google 계정으로 로그인할 수 있습니다. 메시지·첨부
        암호화 키는 Google 로 전달되지 않습니다.
      </p>

      {googleLinked ? (
        <>
          <p className="mt-3 text-sm text-zinc-700">현재 Google 계정이 연결되어 있습니다.</p>
          {hasPassword ? (
            <form className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(event) => void unlink(event)}>
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="google-unlink-password">비밀번호 확인</Label>
                <PasswordInput
                  id="google-unlink-password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="연결 해제에 필요합니다"
                />
              </div>
              <Button type="submit" variant="outline" disabled={busy || password.length === 0}>
                {busy ? <Spinner /> : null}
                연결 해제
              </Button>
            </form>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-amber-600">
              비밀번호가 없는 계정은 Google 연결을 해제할 수 없습니다(로그인 수단 상실 방지).
            </p>
          )}
        </>
      ) : (
        <Button variant="outline" size="sm" className="mt-3" disabled={busy} onClick={() => void link()}>
          {busy ? <Spinner /> : null}
          Google 계정 연결
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
