import { openDB, type DBSchema, type IDBPDatabase } from "idb";

import type { StoredIdentity } from "./crypto/index.ts";
import type { HistoryKeyRecord, RatchetSession } from "./crypto/ratchet.ts";
import type { SenderKeySession } from "./crypto/senderKey.ts";

interface KeystoreDB extends DBSchema {
  identities: {
    key: string;
    value: StoredIdentity;
  };
  ratchetSessions: {
    key: string;
    value: RatchetSession;
  };
  historyKeys: {
    key: string;
    value: HistoryKeyRecord;
  };
  senderKeys: {
    key: string;
    value: SenderKeySession;
  };
}

const canUseIndexedDb = typeof indexedDB !== "undefined";
let dbPromise: Promise<IDBPDatabase<KeystoreDB>> | null = null;

function db(): Promise<IDBPDatabase<KeystoreDB>> {
  dbPromise ??= openDB<KeystoreDB>("onemoments", 3, {
    upgrade(database) {
      if (!database.objectStoreNames.contains("identities")) {
        database.createObjectStore("identities");
      }
      if (!database.objectStoreNames.contains("ratchetSessions")) {
        database.createObjectStore("ratchetSessions");
      }
      if (!database.objectStoreNames.contains("historyKeys")) {
        database.createObjectStore("historyKeys");
      }
      if (!database.objectStoreNames.contains("senderKeys")) {
        database.createObjectStore("senderKeys");
      }
    },
  });
  return dbPromise;
}

const memoryIdentities = new Map<string, StoredIdentity>();
const memorySessions = new Map<string, RatchetSession>();
const memoryHistory = new Map<string, HistoryKeyRecord>();
const memorySenderKeys = new Map<string, SenderKeySession>();

function sessionKey(session: RatchetSession): string {
  return `${session.conversationId}:${session.remoteDeviceId}`;
}

function historyKey(deviceId: string, messageId: string): string {
  return `${deviceId}:${messageId}`;
}

function identityKey(identity: StoredIdentity): string {
  return (identity.userId ?? identity.username).toLowerCase();
}

async function allIdentities(): Promise<StoredIdentity[]> {
  if (!canUseIndexedDb) return [...memoryIdentities.values()];
  return (await db()).getAll("identities");
}

export async function loadIdentity(username: string): Promise<StoredIdentity | null> {
  const key = username.toLowerCase();
  if (!canUseIndexedDb) return memoryIdentities.get(key) ?? null;
  const value = await (await db()).get("identities", key);
  return value ?? null;
}

/** userId 우선, 구버전 username 키는 fallback. */
export async function loadIdentityForUser(
  userId: string,
  username: string,
): Promise<StoredIdentity | null> {
  const byId = await loadIdentity(userId);
  if (byId) return byId;
  return loadIdentity(username);
}

/** 같은 로그인 별칭으로 저장된 실제/decoy identity 목록(중복 userId 제거). */
export async function listIdentitiesForAlias(alias: string): Promise<StoredIdentity[]> {
  const normalized = alias.toLowerCase();
  const seen = new Set<string>();
  const result: StoredIdentity[] = [];
  for (const identity of await allIdentities()) {
    const matches =
      identity.loginAlias?.toLowerCase() === normalized ||
      identity.username.toLowerCase() === normalized;
    if (!matches) continue;
    const key = identityKey(identity);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(identity);
  }
  return result;
}

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  const key = identityKey(identity);
  if (!canUseIndexedDb) {
    memoryIdentities.set(key, identity);
    return;
  }
  await (await db()).put("identities", identity, key);
}

export async function deleteIdentity(username: string): Promise<void> {
  const key = username.toLowerCase();
  if (!canUseIndexedDb) {
    memoryIdentities.delete(key);
    return;
  }
  await (await db()).delete("identities", key);
}

export async function deleteIdentityByUser(userId: string): Promise<void> {
  await deleteIdentity(userId);
}

export async function loadRatchetSession(
  conversationId: string,
  remoteDeviceId: string,
): Promise<RatchetSession | null> {
  const key = `${conversationId}:${remoteDeviceId}`;
  if (!canUseIndexedDb) return memorySessions.get(key) ?? null;
  return (await (await db()).get("ratchetSessions", key)) ?? null;
}

export async function saveRatchetSession(session: RatchetSession): Promise<void> {
  const key = sessionKey(session);
  if (!canUseIndexedDb) {
    memorySessions.set(key, session);
    return;
  }
  await (await db()).put("ratchetSessions", session, key);
}

export async function listRatchetSessions(localDeviceId: string): Promise<RatchetSession[]> {
  if (!canUseIndexedDb) {
    return [...memorySessions.values()].filter(
      (session) => session.localDeviceId === localDeviceId,
    );
  }
  const sessions = await (await db()).getAll("ratchetSessions");
  return sessions.filter((session) => session.localDeviceId === localDeviceId);
}

export async function importRatchetSessions(sessions: RatchetSession[]): Promise<void> {
  if (!canUseIndexedDb) {
    for (const session of sessions) memorySessions.set(sessionKey(session), session);
    return;
  }
  const database = await db();
  const tx = database.transaction("ratchetSessions", "readwrite");
  await Promise.all(
    sessions.map((session) => tx.store.put(session, sessionKey(session))),
  );
  await tx.done;
}

export async function loadHistoryKey(
  localDeviceId: string,
  messageId: string,
): Promise<string | null> {
  const key = historyKey(localDeviceId, messageId);
  if (!canUseIndexedDb) return memoryHistory.get(key)?.key ?? null;
  return (await (await db()).get("historyKeys", key))?.key ?? null;
}

export async function saveHistoryKey(record: HistoryKeyRecord): Promise<void> {
  const key = historyKey(record.deviceId, record.messageId);
  if (!canUseIndexedDb) {
    memoryHistory.set(key, record);
    return;
  }
  await (await db()).put("historyKeys", record, key);
}

export async function listHistoryKeys(localDeviceId: string): Promise<HistoryKeyRecord[]> {
  if (!canUseIndexedDb) {
    return [...memoryHistory.values()].filter((record) => record.deviceId === localDeviceId);
  }
  const records = await (await db()).getAll("historyKeys");
  return records.filter((record) => record.deviceId === localDeviceId);
}

export async function importHistoryKeys(records: HistoryKeyRecord[]): Promise<void> {
  if (!canUseIndexedDb) {
    for (const record of records) {
      memoryHistory.set(historyKey(record.deviceId, record.messageId), record);
    }
    return;
  }
  const database = await db();
  const tx = database.transaction("historyKeys", "readwrite");
  await Promise.all(
    records.map((record) =>
      tx.store.put(record, historyKey(record.deviceId, record.messageId)),
    ),
  );
  await tx.done;
}

export async function loadSenderKey(
  storageKey: string,
): Promise<SenderKeySession | null> {
  if (!canUseIndexedDb) return memorySenderKeys.get(storageKey) ?? null;
  return (await (await db()).get("senderKeys", storageKey)) ?? null;
}

export async function saveSenderKey(session: SenderKeySession): Promise<void> {
  if (!canUseIndexedDb) {
    memorySenderKeys.set(session.storageKey, session);
    return;
  }
  await (await db()).put("senderKeys", session, session.storageKey);
}

export async function listSenderKeys(localDeviceId: string): Promise<SenderKeySession[]> {
  if (!canUseIndexedDb) {
    return [...memorySenderKeys.values()].filter(
      (session) => session.localDeviceId === localDeviceId,
    );
  }
  const sessions = await (await db()).getAll("senderKeys");
  return sessions.filter((session) => session.localDeviceId === localDeviceId);
}

export async function importSenderKeys(sessions: SenderKeySession[]): Promise<void> {
  if (!canUseIndexedDb) {
    for (const session of sessions) memorySenderKeys.set(session.storageKey, session);
    return;
  }
  const database = await db();
  const tx = database.transaction("senderKeys", "readwrite");
  await Promise.all(
    sessions.map((session) => tx.store.put(session, session.storageKey)),
  );
  await tx.done;
}
