import { useQuery } from "@tanstack/react-query";
import { Outlet } from "react-router-dom";

import { CallProvider } from "../calls.tsx";
import { api } from "../lib/api.ts";
import { RealtimeProvider } from "../realtime.tsx";
import { useSession } from "../session.tsx";
import type { ConversationSummary } from "../types.ts";

/**
 * 로그인 후 모든 화면을 감싸는 실시간 레이아웃.
 *
 * 채팅 화면에서만 연결하면 기기 관리·Moments·연락처 화면에서 수신 벨을 놓치므로,
 * 세션이 있는 동안 WS 와 통화 컨텍스트를 앱 전체에 유지한다.
 */
export function RealtimeLayout() {
  const { session, identity } = useSession();
  const enabled = Boolean(session) && Boolean(identity);
  const conversationsQuery = useQuery({
    queryKey: ["conversations"],
    queryFn: () =>
      api<{ conversations: ConversationSummary[] }>("/api/conversations").then(
        (response) => response.conversations,
      ),
    enabled,
    refetchInterval: 30_000,
  });
  const conversationIds = (conversationsQuery.data ?? []).map((item) => item.id);

  return (
    <RealtimeProvider enabled={enabled} conversationIds={conversationIds}>
      <CallProvider>
        <Outlet />
      </CallProvider>
    </RealtimeProvider>
  );
}
