import { Check, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../i18n.tsx";
import { api } from "../lib/api.ts";
import { Alert, Button, Card, Dialog, Input, Label, Spinner } from "./ui.tsx";

type RequestStatus = "pending" | "approved" | "rejected";

interface SignupRequestItem {
  id: string;
  username: string;
  note: string | null;
  status: RequestStatus;
  requestedAt: string;
  reviewNote: string | null;
  completedAt: string | null;
}

function formatDateTime(value: string | null, locale: string = "ko"): string {
  if (!value) return "-";
  return new Date(value).toLocaleString(locale === "en" ? "en-US" : "ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

/**
 * 가입 신청(관리자 승인형) 패널.
 *
 * 승인하면 서버가 **1회용 초대 코드**를 발급한다. 코드는 곧바로 클립보드로 복사해 신청자에게
 * 전달하고, 같은 목록에서 다시 복사할 수 있다. 승인·거절은 감사 로그에 남는다.
 */
export function AdminSignupRequestsPanel() {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<SignupRequestItem[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<SignupRequestItem | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ requests: SignupRequestItem[]; signupRequestEnabled: boolean }>(
        "/api/admin/signup-requests",
      );
      setItems(data.requests);
      setEnabled(data.signupRequestEnabled);
    } catch {
      setError(t("admin.requestFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve(item: SignupRequestItem) {
    setBusyId(item.id);
    setError(null);
    try {
      await api(`/api/admin/signup-requests/${item.id}/approve`, { method: "POST" });
      await load();
    } catch {
      setError(t("admin.requestFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function reject() {
    if (!rejectTarget) return;
    setBusyId(rejectTarget.id);
    setError(null);
    try {
      await api(`/api/admin/signup-requests/${rejectTarget.id}/reject`, {
        method: "POST",
        body: { note: rejectNote.trim() || undefined },
      });
      setRejectTarget(null);
      setRejectNote("");
      await load();
    } catch {
      setError(t("admin.requestFailed"));
    } finally {
      setBusyId(null);
    }
  }

  const pendingCount = items.filter((item) => item.status === "pending").length;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <ShieldCheck className="h-4 w-4" aria-hidden />
            {t("admin.requests.title")}
          </h2>
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">
            {t("admin.requests.pendingCount", { count: pendingCount })}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t("admin.requests.note")}</p>
        {!enabled ? (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t("admin.requests.disabled")}
          </p>
        ) : null}
        <div className="mt-3 flex justify-end">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Spinner /> : null}
            {t("admin.refresh")}
          </Button>
        </div>
      </Card>

      {error ? <Alert variant="error">{error}</Alert> : null}

      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-10">
            <Spinner className="h-5 w-5 text-accent-600" />
          </div>
        ) : items.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-zinc-500">{t("admin.requests.empty")}</p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-sm font-medium text-zinc-900">
                    @{item.username}
                    {item.status !== "pending" ? (
                      <span
                        className={
                          item.status === "approved"
                            ? "rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
                            : "rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500"
                        }
                      >
                        {item.status === "approved"
                          ? t("admin.requests.statusApproved")
                          : t("admin.requests.statusRejected")}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {t("admin.requests.requestedAt", {
                      date: formatDateTime(item.requestedAt, locale),
                    })}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-zinc-600">
                    <span className="font-medium text-zinc-500">
                      {t("admin.requests.reasonLabel")}:{" "}
                    </span>
                    {item.note ?? t("admin.requests.noReason")}
                  </p>
                  {item.status === "rejected" && item.reviewNote ? (
                    <p className="mt-1 text-xs text-zinc-500">
                      {t("admin.requests.rejectReason", { note: item.reviewNote })}
                    </p>
                  ) : null}
                </div>
                {item.status === "pending" ? (
                  <>
                    <Button
                      size="sm"
                      onClick={() => void approve(item)}
                      disabled={busyId === item.id}
                      aria-label={t("admin.requests.approveAria", { username: item.username })}
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden />
                      {busyId === item.id
                        ? t("admin.requests.approving")
                        : t("admin.requests.approve")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRejectTarget(item);
                        setRejectNote("");
                      }}
                      disabled={busyId === item.id}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                      {t("admin.requests.reject")}
                    </Button>
                  </>
                ) : (
                  <span className="text-[11px] text-zinc-400">
                    {item.completedAt ? t("admin.requests.completed") : t("admin.requests.approvedWaiting")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Dialog
        open={rejectTarget !== null}
        onClose={() => setRejectTarget(null)}
        title={t("admin.requests.rejectTitle")}
      >
        <p className="text-sm leading-relaxed text-zinc-600">
          {t("admin.requests.rejectBody", { username: rejectTarget?.username ?? "" })}
        </p>
        <div className="mt-3">
          <Label htmlFor="reject-note">{t("admin.requests.rejectNoteLabel")}</Label>
          <Input
            id="reject-note"
            maxLength={200}
            value={rejectNote}
            onChange={(event) => setRejectNote(event.target.value)}
            placeholder={t("admin.requests.rejectNotePlaceholder")}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setRejectTarget(null)}>
            {t("admin.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => void reject()} disabled={busyId !== null}>
            {busyId !== null ? t("admin.loading") : t("admin.requests.reject")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
