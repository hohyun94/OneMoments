import "fake-indexeddb/auto";

import { openDB } from "idb";
import { describe, expect, it } from "vitest";

import type { RatchetSession } from "./crypto/ratchet.ts";
import { loadRatchetSession } from "./keystore.ts";

const DB_NAME = "onemoments";
const DEVICE = "migration-device";
const CONVERSATION = "migration-conversation";
const REMOTE = "migration-remote-device";

const legacySession: RatchetSession = {
  version: 1,
  conversationId: CONVERSATION,
  localDeviceId: DEVICE,
  remoteDeviceId: REMOTE,
  dhSelfPrivate: "self-private",
  dhSelfPublic: "self-public",
  dhRemote: "remote",
  rootKey: "root",
  sendChainKey: "send-chain",
  recvChainKey: null,
  sendCount: 3,
  recvCount: 2,
  previousSendCount: 0,
  skipped: {},
};

/** v3 스키마의 DB 에 v3 키(`conversationId:remoteDeviceId`)로 세션을 심는다. */
async function seedLegacyDatabase(): Promise<void> {
  const database = await openDB(DB_NAME, 3, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("identities")) db.createObjectStore("identities");
      if (!db.objectStoreNames.contains("ratchetSessions")) db.createObjectStore("ratchetSessions");
      if (!db.objectStoreNames.contains("historyKeys")) db.createObjectStore("historyKeys");
      if (!db.objectStoreNames.contains("senderKeys")) db.createObjectStore("senderKeys");
    },
  });
  await database.put(
    "ratchetSessions",
    legacySession,
    `${CONVERSATION}:${REMOTE}`,
  );
  database.close();
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

describe("keystore IndexedDB migration", () => {
  it("re-keys v3 sessions and scopes them to the local device", async () => {
    await deleteDatabase();
    await seedLegacyDatabase();

    // v4 로 열리는 순간 업그레이드 마이그레이션이 실행된다.
    await expect(loadRatchetSession(DEVICE, CONVERSATION, REMOTE)).resolves.toMatchObject({
      localDeviceId: DEVICE,
      conversationId: CONVERSATION,
      remoteDeviceId: REMOTE,
      sendCount: 3,
    });

    // 다른 계정/기기에서는 같은 대화·상대 기기 세션을 볼 수 없다.
    await expect(
      loadRatchetSession("another-device", CONVERSATION, REMOTE),
    ).resolves.toBeNull();

    const database = await openDB(DB_NAME, 4);
    const keys = await database.getAllKeys("ratchetSessions");
    expect(keys).toEqual([`${DEVICE}:${CONVERSATION}:${REMOTE}`]);
    database.close();
  });
});
