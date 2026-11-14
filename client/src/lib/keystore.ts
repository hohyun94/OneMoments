import { openDB, type DBSchema } from "idb";

import type { StoredIdentity } from "./crypto/index.ts";

interface KeystoreDB extends DBSchema {
  identities: {
    key: string;
    value: StoredIdentity;
  };
}

const dbPromise = openDB<KeystoreDB>("onemoments", 1, {
  upgrade(db) {
    if (!db.objectStoreNames.contains("identities")) {
      db.createObjectStore("identities");
    }
  },
});

export async function loadIdentity(username: string): Promise<StoredIdentity | null> {
  const db = await dbPromise;
  const value = await db.get("identities", username.toLowerCase());
  return value ?? null;
}

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  const db = await dbPromise;
  await db.put("identities", identity, identity.username.toLowerCase());
}

export async function deleteIdentity(username: string): Promise<void> {
  const db = await dbPromise;
  await db.delete("identities", username.toLowerCase());
}
