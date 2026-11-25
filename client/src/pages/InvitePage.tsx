import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useI18n } from "../i18n.tsx";
import { ApiError, api } from "../lib/api.ts";
import { Alert, Card, Spinner } from "../components/ui.tsx";
import type { ConversationSummary } from "../types.ts";

export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setError(t("invite.invalid"));
      return;
    }
    api<{ conversation: ConversationSummary }>(`/api/invites/${token}/accept`, {
      method: "POST",
    })
      .then(async (response) => {
        if (cancelled) return;
        // 전역 레이아웃이 이미 대화 목록을 캐시하고 있으므로, 합류 후 즉시 새로고침한다.
        await queryClient.invalidateQueries({ queryKey: ["conversations"] });
        if (!cancelled) {
          navigate(`/c/${response.conversation.id}`, { replace: true });
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
            caught instanceof ApiError ? caught.message : t("invite.failed"),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, queryClient, token, t]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4">
      <Card className="w-full max-w-md p-6 text-center">
        {error ? (
          <>
            <h1 className="text-lg font-semibold text-zinc-900">{t("invite.errorTitle")}</h1>
            <div className="mt-3 text-left">
              <Alert variant="error">{error}</Alert>
            </div>
            <button
              className="mt-5 text-sm font-medium text-accent-700 hover:underline"
              onClick={() => navigate("/", { replace: true })}
            >
              {t("invite.back")}
            </button>
          </>
        ) : (
          <>
            <Spinner className="mx-auto h-6 w-6 text-accent-600" />
            <p className="mt-3 text-sm text-zinc-600">{t("invite.accepting")}</p>
          </>
        )}
      </Card>
    </div>
  );
}
