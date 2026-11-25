/**
 * 대화별 임시저장(초안).
 *
 * 대화를 전환해도 쓰던 글이 사라지지 않도록 **이 브라우저에만** 보관한다.
 * 내용은 암호화되지 않은 로컬 문자열이므로, 로그아웃/자동 잠금 시 지운다.
 */
export const DRAFT_STORAGE_KEY = "onemoments-drafts";
const MAX_DRAFT_LENGTH = 4_000;

type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): DraftStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readAll(store: DraftStore): Record<string, string> {
  try {
    const raw = store.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function writeAll(store: DraftStore, drafts: Record<string, string>): void {
  try {
    if (Object.keys(drafts).length === 0) store.removeItem(DRAFT_STORAGE_KEY);
    else store.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // 저장 공간 부족/사생활 모드 등은 조용히 무시한다.
  }
}

/** 저장된 초안(없으면 빈 문자열). */
export function loadDraft(conversationId: string, store: DraftStore | null = defaultStore()): string {
  if (!store) return "";
  return readAll(store)[conversationId] ?? "";
}

/** 초안을 저장한다(빈 문자열이면 삭제). */
export function saveDraft(
  conversationId: string,
  text: string,
  store: DraftStore | null = defaultStore(),
): void {
  if (!store) return;
  const trimmed = text.slice(0, MAX_DRAFT_LENGTH);
  const drafts = readAll(store);
  if (trimmed.length === 0) {
    if (!(conversationId in drafts)) return;
    delete drafts[conversationId];
  } else {
    drafts[conversationId] = trimmed;
  }
  writeAll(store, drafts);
}

/** 한 대화의 초안을 지운다. */
export function clearDraft(
  conversationId: string,
  store: DraftStore | null = defaultStore(),
): void {
  saveDraft(conversationId, "", store);
}

/** 모든 초안을 지운다(로그아웃/자동 잠금 시). */
export function clearAllDrafts(store: DraftStore | null = defaultStore()): void {
  if (!store) return;
  writeAll(store, {});
}
