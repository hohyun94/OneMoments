import { CheckCircle2, Clock, RefreshCw, Send, XCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { api, ApiError } from "../lib/api.ts";
import { useI18n } from "../i18n.tsx";
import { Alert, Button, Input, Label, Spinner, Textarea } from "./ui.tsx";

/** 신청 토큰은 브라우저에만 저장한다(서버는 해시만 보관). */
const STORAGE_KEY = "onemoments-signup-request";

type StatusView = {
  status: "pending" | "approved" | "rejected";
  username: string;
  requestedAt: string;
  decidedAt: string | null;
  inviteCode: string | null;
  completed: boolean;
  reviewNote: string | null;
};

function readToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 저장 실패(사생활 모드)해도 이번 세션 동안은 화면 상태를 볼 수 있다.
  }
}

/**
 * 가입 신청서 — 아이디와 한 줄 소개만 보낸다.
 *
 * 비밀번호·기기 키는 **승인 후** 가입 단계에서 입력한다(서버는 승인 전 비밀 정보를 받지 않는다).
 * 승인되면 1회용 초대 코드가 내려오고, `onUseCode` 로 가입 폼에 그 코드를 채워 준다.
 */
export function SignupRequestForm({
  defaultUsername,
  onUseCode,
}: {
  defaultUsername: string;
  onUseCode: (code: string) => void;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState(defaultUsername);
  const [note, setNote] = useState("");
  const [token, setToken] = useState<string | null>(readToken);
  const [view, setView] = useState<StatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function refresh(current: string) {
    setBusy(true);
    try {
      const next = await api<StatusView>(
        `/api/signup-requests/status?token=${encodeURIComponent(current)}`,
      );
      setView(next);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) {
        storeToken(null);
        setToken(null);
        setView(null);
      } else {
        setError(t("signup.request.errorGeneric"));
      }
    } finally {
      setBusy(false);
    }
  }

  // 저장된 신청이 있으면 들어오자마자 상태를 확인한다.
  useEffect(() => {
    if (!token) return;
    void refresh(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const created = await api<{ token: string; status: StatusView["status"] }>(
        "/api/signup-requests",
        { method: "POST", body: { username: username.trim(), note: note.trim() || undefined } },
      );
      storeToken(created.token);
      setToken(created.token);
      await refresh(created.token);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "SIGNUP_REQUEST_PENDING") {
        setError(t("signup.request.errorPending"));
      } else if (caught instanceof ApiError && caught.code === "USERNAME_TAKEN") {
        setError(t("signup.request.errorTaken"));
      } else {
        setError(t("signup.request.errorGeneric"));
      }
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    storeToken(null);
    setToken(null);
    setView(null);
    setNote("");
    setError(null);
    setCopied(false);
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  // 신청 전 — 신청서.
  if (!token || !view) {
    return (
      <form className="space-y-4" onSubmit={onSubmit}>
        <p className="text-xs leading-relaxed text-zinc-500">{t("signup.request.intro")}</p>
        <div className="space-y-1.5">
          <Label htmlFor="request-username">{t("auth.username.label")}</Label>
          <Input
            id="request-username"
            name="requestUsername"
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
          <Label htmlFor="request-note">{t("signup.request.noteLabel")}</Label>
          <Textarea
            id="request-note"
            name="requestNote"
            rows={3}
            maxLength={200}

            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("signup.request.notePlaceholder")}
          />
        </div>
        {error ? <Alert variant="error">{error}</Alert> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Spinner /> : <Send className="h-4 w-4" aria-hidden />}
          {t("signup.request.submit")}
        </Button>
        {busy ? (
          <p className="text-center text-[11px] text-zinc-400">{t("admin.loading")}</p>
        ) : null}
      </form>
    );
  }


  const approved = view.status === "approved" && view.inviteCode !== null;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5">
        {view.status === "pending" ? (
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
        ) : approved ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
        ) : (
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-900">
            {view.status === "pending"
              ? t("signup.request.pending")
              : approved
                ? t("signup.request.approved")
                : view.completed
                  ? t("signup.request.completed")
                  : t("signup.request.rejected")}
          </p>
          <p className="mt-0.5 truncate text-xs text-zinc-500">
            @{view.username} · {t("signup.request.requestedAt", { date: view.requestedAt.slice(0, 10) })}
          </p>
          {view.status === "rejected" && view.reviewNote ? (
            <p className="mt-1 text-xs text-zinc-500">
              {t("signup.request.reason", { note: view.reviewNote })}
            </p>
          ) : null}
        </div>
      </div>

      {approved ? (
        <div className="space-y-2">
          <code className="block rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-center font-mono text-sm tracking-widest text-emerald-900">
            {view.inviteCode}
          </code>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => void copyCode(view.inviteCode ?? "")}
            >
              {copied ? t("signup.request.copied") : t("signup.request.copy")}
            </Button>
            <Button type="button" className="flex-1" onClick={() => onUseCode(view.inviteCode ?? "")}>
              {t("signup.request.useCode")}
            </Button>
          </div>
        </div>
      ) : null}

      {view.status === "pending" ? (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => void refresh(token)}
          disabled={busy}
        >
          {busy ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          {t("signup.request.refresh")}
        </Button>
      ) : null}

      {!approved ? (
        <Button type="button" variant="ghost" className="w-full" onClick={restart}>
          {t("signup.request.restart")}
        </Button>
      ) : null}

      {error ? <Alert variant="error">{error}</Alert> : null}
    </div>
  );
}