import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSearchIndex,
  indexDecryptedMessage,
  removeIndexedMessages,
  searchMessages,
} from "./search.ts";

const base = {
  conversationId: "conversation-1",
  senderUserId: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(async () => {
  await clearSearchIndex();
});

describe("local message search", () => {
  it("finds decrypted messages by case-insensitive substring", async () => {
    await indexDecryptedMessage({
      ...base,
      id: "m1",
      text: "안녕하세요 OneMoments 검색",
    });
    await indexDecryptedMessage({
      ...base,
      id: "m2",
      text: "다른 대화의 메시지",
      conversationId: "conversation-2",
    });

    const korean = await searchMessages("검색");
    expect(korean.map((row) => row.id)).toEqual(["m1"]);

    const english = await searchMessages("onemoments");
    expect(english.map((row) => row.id)).toEqual(["m1"]);

    const scoped = await searchMessages("메시지", { conversationId: "conversation-2" });
    expect(scoped.map((row) => row.id)).toEqual(["m2"]);
  });

  it("ignores blank text and removes deleted messages", async () => {
    await indexDecryptedMessage({ ...base, id: "m1", text: "   " });
    await indexDecryptedMessage({ ...base, id: "m2", text: "삭제될 메시지" });

    expect((await searchMessages("삭제")).map((row) => row.id)).toEqual(["m2"]);
    await removeIndexedMessages(["m2"]);
    expect(await searchMessages("삭제")).toEqual([]);
  });

  it("returns results newest first and respects the limit", async () => {
    await indexDecryptedMessage({
      ...base,
      id: "old",
      text: "같은 검색어",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await indexDecryptedMessage({
      ...base,
      id: "new",
      text: "같은 검색어",
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    expect((await searchMessages("검색어")).map((row) => row.id)).toEqual(["new", "old"]);
    expect(await searchMessages("검색어", { limit: 1 })).toHaveLength(1);
  });
});
