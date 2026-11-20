import type { ConversationSummary } from "../types.ts";

export function conversationName(conversation: ConversationSummary): string {
  if (conversation.kind === "group") return conversation.name ?? "그룹";
  return conversation.peer?.username ?? "삭제된 사용자";
}

/**
 * 대화 목록 필터. 서버는 평문 검색을 제공하지 않으므로 제목(그룹 이름/상대 username)만
 * 클라이언트에서 필터링하고, 안 읽은 대화만 보는 토글을 함께 지원한다.
 */
export function filterConversations(
  conversations: ConversationSummary[],
  query: string,
  unreadOnly: boolean,
): ConversationSummary[] {
  const needle = query.trim().toLowerCase();
  return conversations.filter((conversation) => {
    if (unreadOnly && conversation.unreadCount === 0) return false;
    if (!needle) return true;
    return conversationName(conversation).toLowerCase().includes(needle);
  });
}
