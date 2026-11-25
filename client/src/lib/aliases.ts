/**
 * 대화 상대의 **로컬 별명**.
 *
 * 서버에 저장하지 않고 이 브라우저에만 보관한다(기기별). 로그아웃하면 지운다.
 * `useSyncExternalStore` 로 구독할 수 있도록 스냅샷 객체를 캐시한다.
 */
export const ALIAS_STORAGE_KEY = "onemoments-aliases";
export const MAX_ALIAS_LENGTH = 40;

type AliasStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let cached: Record<string, string> | null = null;
const listeners = new Set<() => void>();

function defaultStore(): AliasStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readFrom(store: AliasStore | null): Record<string, string> {
  if (!store) return {};
  try {
    const raw = store.getItem(ALIAS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        const trimmed = value.trim().slice(0, MAX_ALIAS_LENGTH);
        if (trimmed.length > 0) result[key] = trimmed;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeTo(store: AliasStore | null, aliases: Record<string, string>): void {
  if (!store) return;
  try {
    if (Object.keys(aliases).length === 0) store.removeItem(ALIAS_STORAGE_KEY);
    else store.setItem(ALIAS_STORAGE_KEY, JSON.stringify(aliases));
  } catch {
    // 저장 공간 부족/사생활 모드 등은 무시한다.
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** 저장된 별명 맵. 인자 없이 부르면 같은 참조를 돌려준다(구독 스냅샷용). */
export function loadAliases(store?: AliasStore | null): Record<string, string> {
  if (store !== undefined) return readFrom(store);
  cached ??= readFrom(defaultStore());
  return cached;
}

/** 특정 사용자의 별명(없으면 빈 문자열). */
export function aliasFor(userId: string | null | undefined): string {
  if (!userId) return "";
  return loadAliases()[userId] ?? "";
}

/** 별명을 저장한다(빈 값이면 삭제). 40자로 자른다. */
export function saveAlias(
  userId: string,
  alias: string,
  store?: AliasStore | null,
): void {
  const trimmed = alias.trim().slice(0, MAX_ALIAS_LENGTH);
  if (store !== undefined) {
    const next = { ...readFrom(store) };
    if (trimmed.length === 0) delete next[userId];
    else next[userId] = trimmed;
    writeTo(store, next);
    return;
  }
  const next = { ...loadAliases() };
  if (trimmed.length === 0) delete next[userId];
  else next[userId] = trimmed;
  cached = next;
  writeTo(defaultStore(), next);
  notify();
}

/** 모든 별명을 지운다(로그아웃 시). */
export function clearAliases(store?: AliasStore | null): void {
  if (store !== undefined) {
    writeTo(store, {});
    return;
  }
  cached = {};
  writeTo(defaultStore(), {});
  notify();
}

export function subscribeAliases(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
