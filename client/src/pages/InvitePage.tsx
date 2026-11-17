import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { ApiError, api } from "../lib/api.ts";
import { Alert, Card, Spinner } from "../components/ui.tsx";
import type { ConversationSummary } from "../types.ts";

export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setError("초대 링크가 올바르지 않습니다.");
      return;
    }
    api<{ conversation: ConversationSummary }>(`/api/invites/${token}/accept`, {
      method: "POST",
    })
      .then((response) => {
        if (!cancelled) {
          navigate(`/c/${response.conversation.id}`, { replace: true });
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
            caught instanceof ApiError
              ? caught.message
              : "초대를 수락하지 못했습니다.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, token]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4">
      <Card className="w-full max-w-md p-6 text-center">
        {error ? (
          <>
            <h1 className="text-lg font-semibold text-zinc-900">초대를 열 수 없습니다</h1>
            <div className="mt-3 text-left">
              <Alert variant="error">{error}</Alert>
            </div>
            <button
              className="mt-5 text-sm font-medium text-accent-700 hover:underline"
              onClick={() => navigate("/", { replace: true })}
            >
              대화 목록으로 이동
            </button>
          </>
        ) : (
          <>
            <Spinner className="mx-auto h-6 w-6 text-accent-600" />
            <p className="mt-3 text-sm text-zinc-600">그룹 초대를 수락하는 중…</p>
          </>
        )}
      </Card>
    </div>
  );
}
