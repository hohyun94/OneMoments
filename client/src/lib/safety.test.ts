import { describe, expect, it } from "vitest";

import { computeSafetyNumber, type SafetyDevice } from "./safety.ts";
import { toBase64 } from "./crypto/encoding.ts";

function key(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

function device(userId: string): SafetyDevice {
  return {
    userId,
    identityPublicKey: key(),
    signingPublicKey: key(),
  };
}

describe("safety number", () => {
  it("produces 60 digits in 12 groups", async () => {
    const result = await computeSafetyNumber([device("user-a"), device("user-b")]);
    expect(result).not.toBeNull();
    expect(result?.digits).toMatch(/^\d{60}$/);
    expect(result?.groups).toHaveLength(12);
    expect(result?.hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of device and user order", async () => {
    const a1 = device("user-a");
    const a2 = device("user-a");
    const b1 = device("user-b");

    const first = await computeSafetyNumber([a1, b1, a2]);
    const second = await computeSafetyNumber([b1, a2, a1]);
    expect(second?.digits).toBe(first?.digits);
    expect(second?.hex).toBe(first?.hex);
  });

  it("changes when a device is added or its key changes", async () => {
    const a1 = device("user-a");
    const b1 = device("user-b");
    const base = await computeSafetyNumber([a1, b1]);

    const addedDevice = await computeSafetyNumber([a1, b1, device("user-b")]);
    expect(addedDevice?.digits).not.toBe(base?.digits);
    expect(addedDevice?.hex).not.toBe(base?.hex);

    const replaced = await computeSafetyNumber([
      a1,
      { ...b1, identityPublicKey: key() },
    ]);
    expect(replaced?.digits).not.toBe(base?.digits);
  });

  it("returns null until both participants have devices", async () => {
    expect(await computeSafetyNumber([])).toBeNull();
    expect(await computeSafetyNumber([device("user-a")])).toBeNull();
  });
});
