import { describe, expect, it } from "vitest";

import { withCryptoLock } from "./lock.ts";

describe("crypto lock", () => {
  it("serializes tasks that share a name", async () => {
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];

    const task = (index: number) => async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(index);
      running -= 1;
      return index;
    };

    const results = await Promise.all([
      withCryptoLock("same-session", task(1)),
      withCryptoLock("same-session", task(2)),
      withCryptoLock("same-session", task(3)),
    ]);

    expect(maxRunning).toBe(1);
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([1, 2, 3]);
  });

  it("keeps the queue usable after a task throws", async () => {
    await expect(
      withCryptoLock("failing-session", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(withCryptoLock("failing-session", async () => "ok")).resolves.toBe("ok");
  });

  it("does not block unrelated sessions", async () => {
    const started: string[] = [];
    const task = (label: string) => async () => {
      started.push(label);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return label;
    };

    await Promise.all([
      withCryptoLock("session-a", task("a")),
      withCryptoLock("session-b", task("b")),
    ]);

    expect(started).toEqual(["a", "b"]);
  });
});
