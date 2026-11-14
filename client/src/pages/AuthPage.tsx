import { KeyRound, Lock } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ApiError } from "../lib/api.ts";
import { Alert, Button, Card, Input, Label, Spinner } from "../components/ui.tsx";
import { useSession } from "../session.tsx";

function messageOf(error: unknown): string {
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
  const { login, register, lastUsername } = useSession();
  const [mode, setMode] = useState<"login" | "register">("login");
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
      else await register(username, password);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-gradient-to-br from-violet-50 via-white to-zinc-100">
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-600 text-white shadow-lg shadow-violet-600/20">
            <Lock className="h-6 w-6" aria-hidden />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">OneMoments</h1>
          <p className="mt-1 text-sm text-zinc-500">
            두 사람만 읽을 수 있는 1:1 암호화 메신저
          </p>
        </div>

        <Card className="p-6">
          <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1">
            {(["login", "register"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setError(null);
                }}
                className={
                  mode === value
                    ? "rounded-md bg-white px-3 py-2 text-sm font-medium text-zinc-900 shadow-sm"
                    : "rounded-md px-3 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-700"
                }
                aria-pressed={mode === value}
              >
                {value === "login" ? "로그인" : "가입"}
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
              <Label htmlFor="password">비밀번호</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={mode === "login" ? 1 : 10}
                maxLength={200}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={mode === "register" ? "10자 이상" : ""}
              />
            </div>

            {mode === "register" ? (
              <div className="space-y-1.5">
                <Label htmlFor="confirm">비밀번호 확인</Label>
                <Input
                  id="confirm"
                  name="confirm"
                  type="password"
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

            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Spinner /> : <KeyRound className="h-4 w-4" aria-hidden />}
              {mode === "login" ? "로그인" : "가입하고 시작하기"}
            </Button>
          </form>
        </Card>

        <p className="mt-5 text-center text-xs leading-relaxed text-zinc-500">
          기기 키는 이 브라우저에만 저장됩니다. 서버는 메시지 내용을 복호화할 수 없습니다.
        </p>
      </div>
    </div>
  );
}
