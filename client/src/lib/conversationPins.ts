/**
 * 대화 목록 고정(내 화면 정렬용). 서버에 저장하지 않고 기기 로컬(localStorage)에만 둔다.
 * 계정(userId)별로 분리해 같은 브라우저의 다른 계정과 섞이지 않게 한다.
 */
const KEY_PREFIX = "onemoments:pinnedConversations:";

function storage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

export function loadPinnedConversations(userId: string): string[] {
  const raw = storage()?.getItem(`${KEY_PREFIX}${userId}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

export function togglePinnedConversation(userId: string, conversationId: string): string[] {
  const current = loadPinnedConversations(userId);
  const next = current.includes(conversationId)
    ? current.filter((id) => id !== conversationId)
    : [conversationId, ...current];
  storage()?.setItem(`${KEY_PREFIX}${userId}`, JSON.stringify(next));
  return next;
}

/** 고정된 대화를 먼저, 나머지는 원래 순서를 유지한다. */
export function sortPinnedFirst<T extends { id: string }>(
  conversations: T[],
  pinnedIds: string[],
): T[] {
  if (pinnedIds.length === 0) return conversations;
  const pinned = new Set(pinnedIds);
  return [
    ...conversations.filter((conversation) => pinned.has(conversation.id)),
    ...conversations.filter((conversation) => !pinned.has(conversation.id)),
  ];
}
