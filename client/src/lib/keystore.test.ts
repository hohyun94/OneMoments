import { describe, expect, it } from "vitest";

import { createIdentityWithBackend, type StoredIdentity } from "./crypto/index.ts";
import type { RatchetSession } from "./crypto/ratchet.ts";
import type { SenderKeySession } from "./crypto/senderKey.ts";
import {
  clearDeviceState,
  deleteIdentityByUser,
  listHistoryKeys,
  listIdentitiesForAlias,
  listRatchetSessions,
  listSenderKeys,
  loadIdentityForUser,
  saveHistoryKey,
  saveIdentity,
  saveRatchetSession,
  saveSenderKey,
} from "./keystore.ts";

function ratchetSession(localDeviceId: string, remoteDeviceId: string): RatchetSession {
  return {
    version: 1,
    conversationId: "conv-1",
    localDeviceId,
    remoteDeviceId,
    dhSelfPrivate: "self-private",
    dhSelfPublic: "self-public",
    dhRemote: "remote",
    rootKey: "root",
    sendChainKey: "send-chain",
    recvChainKey: null,
    sendCount: 0,
    recvCount: 0,
    previousSendCount: 0,
    skipped: {},
  };
}

function senderKeySession(localDeviceId: string): SenderKeySession {
  return {
    version: 1,
    storageKey: `send:conv-1:${localDeviceId}:key-1`,
    mode: "send",
    conversationId: "conv-1",
    localDeviceId,
    senderDeviceId: localDeviceId,
    senderKeyId: "key-1",
    chainKey: "chain",
    iteration: 0,
    distributedDeviceIds: [],
    skipped: {},
  };
}

describe("profile-scoped identity storage", () => {
  it("keeps real and decoy identities for the same login alias", async () => {
    const base = await createIdentityWithBackend("noble");
    const real: StoredIdentity = {
      ...base,
      username: "sharedalias",
      loginAlias: "sharedalias",
      userId: "real-user-id",
      deviceId: "real-device-id",
    };
    const decoy: StoredIdentity = {
      ...base,
      username: "decoy_handle",
      loginAlias: "sharedalias",
      userId: "decoy-user-id",
      deviceId: "decoy-device-id",
    };

    await saveIdentity(real);
    await saveIdentity(decoy);

    const candidates = await listIdentitiesForAlias("sharedalias");
    expect(candidates.map((identity) => identity.userId).sort()).toEqual([
      "decoy-user-id",
      "real-user-id",
    ]);
    await expect(loadIdentityForUser("decoy-user-id", "decoy_handle")).resolves.toMatchObject({
      username: "decoy_handle",
      deviceId: "decoy-device-id",
    });

    await deleteIdentityByUser("decoy-user-id");
    const remaining = await listIdentitiesForAlias("sharedalias");
    expect(remaining.map((identity) => identity.userId)).toEqual(["real-user-id"]);
  });

  it("clears ratchet sessions, history keys and sender keys for a revoked device", async () => {
    const revoked = "revoked-device";
    const kept = "kept-device";

    await saveRatchetSession(ratchetSession(revoked, "peer-device"));
    await saveRatchetSession(ratchetSession(kept, "peer-device"));
    await saveHistoryKey({
      deviceId: revoked,
      messageId: "message-1",
      key: "message-key",
      savedAt: Date.now(),
    });
    await saveHistoryKey({
      deviceId: kept,
      messageId: "message-1",
      key: "message-key",
      savedAt: Date.now(),
    });
    await saveSenderKey(senderKeySession(revoked));
    await saveSenderKey(senderKeySession(kept));

    await clearDeviceState(revoked);

    expect(await listRatchetSessions(revoked)).toEqual([]);
    expect(await listHistoryKeys(revoked)).toEqual([]);
    expect(await listSenderKeys(revoked)).toEqual([]);
    // 다른 기기 상태는 그대로 남는다.
    expect(await listRatchetSessions(kept)).toHaveLength(1);
    expect(await listHistoryKeys(kept)).toHaveLength(1);
    expect(await listSenderKeys(kept)).toHaveLength(1);
  });
});
