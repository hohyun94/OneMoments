import { describe, expect, it } from "vitest";

import { createIdentityWithBackend, type StoredIdentity } from "./crypto/index.ts";
import {
  deleteIdentityByUser,
  listIdentitiesForAlias,
  loadIdentityForUser,
  saveIdentity,
} from "./keystore.ts";

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
});
