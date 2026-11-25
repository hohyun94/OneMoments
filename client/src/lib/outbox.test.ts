import { beforeEach, describe, expect, it } from "vitest";

import {
  clearOutbox,
  countOutgoing,
  enqueueOutgoing,
  listOutgoing,
  markOutgoingAttempt,
  removeOutgoing,
} from "./outbox.ts";

const base = {
  conversationId: "conversation-1",
  text: "안녕",
};

beforeEach(async () => {
  await clearOutbox();
});

describe("offline outbox", () => {
  it("queues messages in send order and removes them by id", async () => {
    await enqueueOutgoing({
      ...base,
      id: "m2",
      text: "두번째",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    await enqueueOutgoing({
      ...base,
      id: "m1",
      text: "첫번째",
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    expect((await listOutgoing()).map((row) => row.id)).toEqual(["m1", "m2"]);
    expect(await countOutgoing()).toBe(2);

    await removeOutgoing("m1");
    expect((await listOutgoing()).map((row) => row.id)).toEqual(["m2"]);
  });

  it("filters by conversation and keeps one entry per client message id", async () => {
    await enqueueOutgoing({ ...base, id: "a", text: "one" });
    await enqueueOutgoing({ ...base, id: "b", conversationId: "conversation-2", text: "two" });
    await enqueueOutgoing({ ...base, id: "a", text: "one-updated" });

    expect((await listOutgoing("conversation-1")).map((row) => row.text)).toEqual([
      "one-updated",
    ]);
    expect(await countOutgoing()).toBe(2);
  });

  it("records retry attempts without dropping the message", async () => {
    await enqueueOutgoing({ ...base, id: "a", text: "재시도" });
    await markOutgoingAttempt("a", "offline");
    await markOutgoingAttempt("a");

    const [row] = await listOutgoing();
    expect(row?.attempts).toBe(2);
    expect(row?.lastError).toBe("offline");
    expect(await countOutgoing()).toBe(1);
  });

  it("keeps at most 100 queued messages (drops the oldest)", async () => {
    for (let index = 0; index < 105; index += 1) {
      await enqueueOutgoing({
        ...base,
        id: `m${index}`,
        text: `메시지 ${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }
    const rows = await listOutgoing();
    expect(rows).toHaveLength(100);
    expect(rows[0]?.id).toBe("m5");
  });

  it("clears every queued message", async () => {
    await enqueueOutgoing({ ...base, id: "a", text: "남은 메시지" });
    await clearOutbox();
    expect(await countOutgoing()).toBe(0);
    expect(await listOutgoing()).toEqual([]);
  });
});
