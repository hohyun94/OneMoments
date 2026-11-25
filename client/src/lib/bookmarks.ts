import { openDB, type DBSchema, type IDBPDatabase } from "idb";

/**
 * 메시지 북마크(저장함).
 *
 * 서버에는 저장되지 않고 이 기기의 IndexedDB 에만 남는다. 메시지 본문은
 * 복호화된 시점의 스냅샷이며, 원문이 삭제되어도 북마크에는 남는다(사용자가 지울 수 있다).
 * IndexedDB 를 쓸 수 없으면 메모리로만 동작한다(새로고침 시 사라짐).
 */
export interface BookmarkRecord {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  createdAt: string;
  text: string;
  savedAt: string;
}

const DB_NAME = "onemoments-bookmarks";
const DB_VERSION = 1;
const MAX_TEXT_LENGTH = 2_000;
const canUseIndexedDb = typeof indexedDB !== "undefined";

interface BookmarksDB extends DBSchema {
  bookmarks: {
    key: string;
    value: BookmarkRecord;
    indexes: { "by-saved": string };
  };
}

let dbPromise: Promise<IDBPDatabase<BookmarksDB>> | null = null;
const memory = new Map<string, BookmarkRecord>();

function db(): Promise<IDBPDatabase<BookmarksDB>> {
  dbPromise ??= openDB<BookmarksDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains("bookmarks")) {
        const store = database.createObjectStore("bookmarks", { keyPath: "messageId" });
        store.createIndex("by-saved", "savedAt");
      }
    },
  });
  return dbPromise;
}

function normalize(record: Omit<BookmarkRecord, "savedAt"> & { savedAt?: string }): BookmarkRecord {
  return {
    ...record,
    text: record.text.slice(0, MAX_TEXT_LENGTH),
    savedAt: record.savedAt ?? new Date().toISOString(),
  };
}

export async function addBookmark(
  record: Omit<BookmarkRecord, "savedAt"> & { savedAt?: string },
): Promise<void> {
  const value = normalize(record);
  if (!canUseIndexedDb) {
    memory.set(value.messageId, value);
    return;
  }
  try {
    await (await db()).put("bookmarks", value);
  } catch {
    memory.set(value.messageId, value);
  }
}

export async function removeBookmark(messageId: string): Promise<void> {
  memory.delete(messageId);
  if (!canUseIndexedDb) return;
  try {
    await (await db()).delete("bookmarks", messageId);
  } catch {
    // 무시
  }
}

export async function isBookmarked(messageId: string): Promise<boolean> {
  if (memory.has(messageId)) return true;
  if (!canUseIndexedDb) return false;
  try {
    const row = await (await db()).get("bookmarks", messageId);
    return row !== undefined;
  } catch {
    return false;
  }
}

/** 최근 저장순. text 가 비어 있는 항목(첨부 메시지)도 포함한다. */
export async function listBookmarks(limit = 200): Promise<BookmarkRecord[]> {
  if (!canUseIndexedDb) {
    return [...memory.values()]
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
      .slice(0, limit);
  }
  try {
    const rows = await (await db()).getAllFromIndex("bookmarks", "by-saved");
    return rows.reverse().slice(0, limit);
  } catch {
    return [...memory.values()]
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
      .slice(0, limit);
  }
}

export async function countBookmarks(): Promise<number> {
  if (!canUseIndexedDb) return memory.size;
  try {
    return await (await db()).count("bookmarks");
  } catch {
    return memory.size;
  }
}

export async function clearBookmarks(): Promise<void> {
  memory.clear();
  if (!canUseIndexedDb) return;
  try {
    await (await db()).clear("bookmarks");
  } catch {
    // 무시
  }
}
