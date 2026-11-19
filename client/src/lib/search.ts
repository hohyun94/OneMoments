import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface SearchableMessage {
  id: string;
  conversationId: string;
  senderUserId: string;
  createdAt: string;
  text: string;
}

interface SearchDB extends DBSchema {
  messages: {
    key: string;
    value: SearchableMessage;
    indexes: { "by-conversation": string };
  };
}

const DB_NAME = "onemoments-search";
const DB_VERSION = 1;
const canUseIndexedDb = typeof indexedDB !== "undefined";

let dbPromise: Promise<IDBPDatabase<SearchDB>> | null = null;
const memory = new Map<string, SearchableMessage>();

function db(): Promise<IDBPDatabase<SearchDB>> {
  dbPromise ??= openDB<SearchDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains("messages")) {
        const store = database.createObjectStore("messages", { keyPath: "id" });
        store.createIndex("by-conversation", "conversationId");
      }
    },
  });
  return dbPromise;
}

/** 복호화에 성공한 텍스트만 로컬 검색 인덱스에 넣는다. 서버로 전송하지 않는다. */
export async function indexDecryptedMessage(message: SearchableMessage): Promise<void> {
  const text = message.text.trim();
  if (text.length === 0) return;
  const record = { ...message, text };
  if (!canUseIndexedDb) {
    memory.set(record.id, record);
    return;
  }
  try {
    await (await db()).put("messages", record);
  } catch {
    // 검색 인덱스 실패가 채팅 표시를 막지 않는다.
  }
}

export async function removeIndexedMessages(messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  if (!canUseIndexedDb) {
    for (const id of messageIds) memory.delete(id);
    return;
  }
  try {
    const database = await db();
    await Promise.all(messageIds.map((id) => database.delete("messages", id)));
  } catch {
    // 무시
  }
}

export async function clearSearchIndex(): Promise<void> {
  memory.clear();
  if (!canUseIndexedDb) return;
  try {
    await (await db()).clear("messages");
  } catch {
    // 무시
  }
}

export interface SearchOptions {
  conversationId?: string;
  limit?: number;
}

/** 로컬에 복호화된 메시지에서만 검색한다(대소문자 무시 부분 일치). */
export async function searchMessages(
  query: string,
  options: SearchOptions = {},
): Promise<SearchableMessage[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const limit = options.limit ?? 50;

  let rows: SearchableMessage[];
  if (!canUseIndexedDb) {
    rows = [...memory.values()];
  } else {
    try {
      const database = await db();
      rows = options.conversationId
        ? await database.getAllFromIndex(
            "messages",
            "by-conversation",
            options.conversationId,
          )
        : await database.getAll("messages");
    } catch {
      return [];
    }
  }

  return rows
    .filter((row) => row.text.toLowerCase().includes(needle))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}
