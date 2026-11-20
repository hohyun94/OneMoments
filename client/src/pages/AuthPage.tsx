import { KeyRound, Lock, ShieldQuestion } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ApiError } from "../lib/api.ts";
import { BackupError } from "../lib/crypto/index.ts";
import { Alert, Button, Card, Input, Label, PasswordInput, Spinner } from "../components/ui.tsx";
import { useSession } from "../session.tsx";

function messageOf(error: unknown): string {
  if (error instanceof BackupError) {
    return error.reason === "passphrase"
      ? "복구 암호가 올바르지 않습니다."
      : "백업 형식이 올바르지 않습니다.";
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case "USERNAME_TAKEN":
        return "이미 사용 중인 아이디입니다.";
      case "UNAUTHORIZED":
        return "아이디 또는 비밀번호가 올바르지 않습니다.";
      case "VALIDATION_ERROR":
        return "입력값을 확인해 주세요. 아이디는 3~32자, 비밀번호는 10자 이상입니다.";
      case "TOO_MANY_REQUESTS":
        return "시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.";
      case "DEVICE_REQUIRED":
        return "기기 등록에 실패했습니다. 다시 시도해 주세요.";
      case "BACKUP_NOT_FOUND":
        return "이 계정의 키 백업을 찾을 수 없습니다.";
      case "RECOVERY_UNAVAILABLE":
        return "복구할 수 없는 기기입니다(폐기되었거나 존재하지 않음).";
      case "RECOVERY_CHALLENGE_INVALID":
        return "복구 요청이 만료되었습니다. 다시 시도해 주세요.";
      default:
        return error.message;
    }
  }
  if (error instanceof Error && /WebCrypto|subtle/i.test(error.message)) {
    return "이 브라우저에서는 암호화 기능을 사용할 수 없습니다. 최신 브라우저를 사용해 주세요.";
  }
  return "문제가 발생했습니다. 잠시 후 다시 시도해 주세요.";
}

export function AuthPage() {
  const { login, register, recover, lastUsername } = useSession();
  const [mode, setMode] = useState<"login" | "register" | "recover">("login");
  const [username, setUsername] = useState(lastUsername);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (mode === "register" && password !== confirm) {
      setError("비밀번호가 서로 다릅니다.");
      return;
    }

    setBusy(true);
    try {
      if (mode === "login") await login(username, password);
      else if (mode === "register") await register(username, password);
      else await recover(username, password);
    } catch (caught) {
      if (
        mode === "recover" &&
        caught instanceof ApiError &&
        caught.status === 401
      ) {
        setError("복구 암호가 올바르지 않거나 백업이 손상되었습니다.");
      } else {
        setError(messageOf(caught));
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
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-600 text-accent-contrast shadow-lg shadow-accent-600/20">
            <Lock className="h-6 w-6" aria-hidden />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">OneMoments</h1>
        </div>

        <Card className="p-6">
          <div className="mb-5 grid grid-cols-3 gap-1 rounded-lg bg-zinc-100 p-1">
            {(
              [
                { value: "login", label: "로그인" },
                { value: "register", label: "가입" },
                { value: "recover", label: "복구" },
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

          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="username">아이디</Label>
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
                {mode === "recover" ? "복구 암호" : "비밀번호"}
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
                    ? "10자 이상"
                    : mode === "recover"
                      ? "백업할 때 설정한 복구 암호"
                      : ""
                }
              />
            </div>

            {mode === "register" ? (
              <div className="space-y-1.5">
                <Label htmlFor="confirm">비밀번호 확인</Label>
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

            {error ? <Alert variant="error">{error}</Alert> : null}

            {mode === "recover" ? (
              <p className="text-xs leading-relaxed text-zinc-500">
                복구 암호는 서버로 전송되지 않습니다. 이 기기의 이전 세션은 로그아웃되고,
                백업한 기기 키로 대화 이력을 이어서 복호화합니다.
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
                ? "로그인"
                : mode === "register"
                  ? "가입하고 시작하기"
                  : "백업으로 복구"}
            </Button>
          </form>
        </Card>

        <p className="mt-5 text-center text-xs leading-relaxed text-zinc-500">
          {mode === "recover"
            ? "백업이 없거나 복구 암호를 잊으면 서버에서도 키를 복구할 수 없습니다."
            : "기기 키는 이 브라우저에만 저장됩니다. 서버는 메시지 내용을 복호화할 수 없습니다."}
        </p>
      </div>
    </div>
  );
}
