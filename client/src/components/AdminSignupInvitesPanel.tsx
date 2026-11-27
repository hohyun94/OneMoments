import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { api } from "../lib/api.ts";
import { useI18n } from "../i18n.tsx";
import { Alert, Button, Card, Input, Label, Spinner, cn } from "./ui.tsx";

interface SignupInvite {
  id: string;
  code: string;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  active: boolean;
}

function inviteStatus(invite: SignupInvite): string {
  if (invite.revokedAt) return "admin.invites.status.revoked";
  if (invite.usedCount >= invite.maxUses) return "admin.invites.status.used";
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) return "admin.invites.status.expired";
  return "admin.invites.status.active";
}

/**
 * 가입 초대 코드 관리.
 *
 * `SIGNUP_MODE=invite` 일 때 새 사용자를 초대할 코드를 발급/폐기한다.
 * 코드는 서버에만 저장되고, 발급 직후 화면에서 복사해 전달한다.
 */
export function AdminSignupInvitesPanel() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [maxUses, setMaxUses] = useState("1");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["admin", "signup-invites"],
    queryFn: () =>
      api<{ invites: SignupInvite[]; signupMode: string }>("/api/admin/signup-invites"),
  });

  const createMutation = useMutation({
    mutationFn: (input: { maxUses: number; expiresInDays: number | null }) =>
      api<{ invite: SignupInvite }>("/api/admin/signup-invites", {
        method: "POST",
        body: input,
      }),
    onSuccess: (response) => {
      setCreatedCode(response.invite.code);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "signup-invites"] });
    },
    onError: () => setError(t("admin.invites.issueFailed")),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) =>
      api(`/api/admin/signup-invites/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "signup-invites"] });
    },
    onError: () => setError(t("admin.invites.revokeFailed")),
  });

  async function copy(code: string, id: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((value) => (value === id ? null : value)), 1_500);
    } catch {
      setError(t("admin.invites.copyFailed"));
    }
  }

  const invites = query.data?.invites ?? [];
  const signupMode = query.data?.signupMode ?? "open";

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-900">{t("admin.invites.title")}</h2>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium",
              signupMode === "invite"
                ? "bg-emerald-100 text-emerald-700"
                : signupMode === "closed"
                  ? "bg-rose-100 text-rose-700"
                  : "bg-zinc-100 text-zinc-600",
            )}
          >
            {t("admin.invites.policy", { mode: signupMode })}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          {signupMode === "invite"
            ? t("admin.invites.hintInvite")
            : t("admin.invites.hintOther", { mode: signupMode })}
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="w-24">
            <Label htmlFor="invite-max-uses">{t("admin.invites.maxUses")}</Label>
            <Input
              id="invite-max-uses"
              type="number"
              min={1}
              max={100}
              value={maxUses}
              onChange={(event) => setMaxUses(event.target.value)}
            />
          </div>
          <div className="w-32">
            <Label htmlFor="invite-expires">{t("admin.invites.expires")}</Label>
            <select
              id="invite-expires"
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(event.target.value)}
              className="h-10 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-800"
            >
              <option value="">{t("admin.invites.expiry.never")}</option>
              <option value="1">{t("admin.invites.expiry.days", { count: 1 })}</option>
              <option value="7">{t("admin.invites.expiry.days", { count: 7 })}</option>
              <option value="30">{t("admin.invites.expiry.days", { count: 30 })}</option>
            </select>
          </div>
          <Button
            type="button"
            onClick={() =>
              createMutation.mutate({
                maxUses: Math.max(1, Math.min(100, Number(maxUses) || 1)),
                expiresInDays: expiresInDays ? Number(expiresInDays) : null,
              })
            }
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? <Spinner /> : <Plus className="h-4 w-4" aria-hidden />}
            {t("admin.invites.issue")}
          </Button>
        </div>

        {createdCode ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
            <code data-testid="created-invite-code" className="font-mono text-sm text-emerald-900">
              {createdCode}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copy(createdCode, "created")}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              {copiedId === "created" ? t("admin.invites.copied") : t("admin.invites.copy")}
            </Button>
          </div>
        ) : null}
        {error ? (
          <div className="mt-3">
            <Alert variant="error">{error}</Alert>
          </div>
        ) : null}
      </Card>

      <Card className="p-4">
        <h3 className="text-sm font-semibold text-zinc-900">{t("admin.invites.list")}</h3>
        {query.isLoading ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-zinc-500">
            <Spinner /> {t("admin.invites.loading")}
          </p>
        ) : invites.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">{t("admin.invites.empty")}</p>
        ) : (
          <ul className="mt-2 divide-y divide-zinc-100">
            {invites.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                <code className="font-mono text-sm text-zinc-800">{invite.code}</code>
                <span className="text-zinc-500">
                  {invite.usedCount}/{invite.maxUses}
                </span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                    invite.active ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500",
                  )}
                >
                  {t(inviteStatus(invite))}
                </span>
                <span className="text-zinc-400">
                  {invite.expiresAt
                    ? t("admin.invites.expiresAt", {
                        date: new Date(invite.expiresAt).toLocaleDateString(
                          locale === "en" ? "en-US" : "ko-KR",
                        ),
                      })
                    : t("admin.invites.expiry.never")}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void copy(invite.code, invite.id)}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                    {copiedId === invite.id ? t("admin.invites.copied") : t("admin.invites.copy")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => revokeMutation.mutate(invite.id)}
                    disabled={Boolean(invite.revokedAt) || revokeMutation.isPending}
                    aria-label={t("admin.invites.revokeAria", { code: invite.code })}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    {t("admin.invites.revoke")}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
