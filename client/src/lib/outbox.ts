import { openDB, type DBSchema, type IDBPDatabase } from "idb";

/**
 * 오프라인 전송 큐(아웃박스).
 *
 * 네트워크 단절로 전송에 실패한 메시지를 이 기기에 보관했다가 연결되면 다시 보낸다.
 * 본문은 **평문**으로 저장된다(전송 시 다시 암호화). 로그아웃하면 지운다.
 * IndexedDB 를 쓸 수 없으면 메모리로만 동작한다.
 */
export interface OutgoingMessage {
  /** clientMessageId — 재전송 멱등성 키로도 쓰인다. */
  id: string;
  conversationId: string;
  text: string;
  kind?: string;
  viewOnce?: boolean;
  targetMessageId?: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

const DB_NAME = "onemoments-outbox";
const DB_VERSION = 1;
const MAX_ITEMS = 100;
const canUseIndexedDb = typeof indexedDB !== "undefined";

interface OutboxDB extends DBSchema {
  outbox: {
    key: string;
    value: OutgoingMessage;
    indexes: { "by-conversation": string };
  };
}

let dbPromise: Promise<IDBPDatabase<OutboxDB>> | null = null;
const memory = new Map<string, OutgoingMessage>();

function db(): Promise<IDBPDatabase<OutboxDB>> {
  dbPromise ??= openDB<OutboxDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains("outbox")) {
        const store = database.createObjectStore("outbox", { keyPath: "id" });
        store.createIndex("by-conversation", "conversationId");
      }
    },
  });
  return dbPromise;
}

async function readAll(): Promise<OutgoingMessage[]> {
  if (!canUseIndexedDb) return [...memory.values()];
  try {
    return await (await db()).getAll("outbox");
  } catch {
    return [...memory.values()];
  }
}

/** 전송 실패한 메시지를 큐에 넣는다(오래된 항목부터 버려 최대 100건 유지). */
export async function enqueueOutgoing(
  record: Omit<OutgoingMessage, "attempts" | "createdAt"> & {
    createdAt?: string;
    attempts?: number;
  },
): Promise<void> {
  const value: OutgoingMessage = {
    ...record,
    createdAt: record.createdAt ?? new Date().toISOString(),
    attempts: record.attempts ?? 0,
  };
  const rows = (await readAll()).filter((row) => row.id !== value.id);
  rows.push(value);
  const trimmed = rows
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-MAX_ITEMS);

  memory.clear();
  for (const row of trimmed) memory.set(row.id, row);
  if (!canUseIndexedDb) return;
  try {
    const database = await db();
    const keep = new Set(trimmed.map((row) => row.id));
    const existing = await database.getAllKeys("outbox");
    await Promise.all(
      existing.filter((key) => !keep.has(key)).map((key) => database.delete("outbox", key)),
    );
    await Promise.all(trimmed.map((row) => database.put("outbox", row)));
  } catch {
    // 실패해도 메모리 큐로 계속 동작한다.
  }
}

/** 대화별(또는 전체) 대기 메시지. 보낸 순서(createdAt) 오름차순. */
export async function listOutgoing(conversationId?: string): Promise<OutgoingMessage[]> {
  const rows = (await readAll()).filter(
    (row) => conversationId === undefined || row.conversationId === conversationId,
  );
  return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function removeOutgoing(id: string): Promise<void> {
  memory.delete(id);
  if (!canUseIndexedDb) return;
  try {
    await (await db()).delete("outbox", id);
  } catch {
    // 무시
  }
}

/** 재시도 실패를 기록한다(항목은 유지). */
export async function markOutgoingAttempt(id: string, error?: string): Promise<void> {
  const row = (await readAll()).find((item) => item.id === id);
  if (!row) return;
  const next: OutgoingMessage = {
    ...row,
    attempts: row.attempts + 1,
    ...(error === undefined ? {} : { lastError: error }),
  };
  memory.set(id, next);
  if (!canUseIndexedDb) return;
  try {
    await (await db()).put("outbox", next);
  } catch {
    // 무시
  }
}

export async function countOutgoing(): Promise<number> {
  if (!canUseIndexedDb) return memory.size;
  try {
    return await (await db()).count("outbox");
  } catch {
    return memory.size;
  }
}

export async function clearOutbox(): Promise<void> {
  memory.clear();
  if (!canUseIndexedDb) return;
  try {
    await (await db()).clear("outbox");
  } catch {
    // 무시
  }
}
