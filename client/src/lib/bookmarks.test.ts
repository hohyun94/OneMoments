import { beforeEach, describe, expect, it } from "vitest";

import {
  addBookmark,
  clearBookmarks,
  countBookmarks,
  isBookmarked,
  listBookmarks,
  removeBookmark,
} from "./bookmarks.ts";

const base = {
  conversationId: "conversation-1",
  senderUserId: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(async () => {
  await clearBookmarks();
});

describe("saved messages", () => {
  it("adds, detects and removes a bookmark", async () => {
    expect(await isBookmarked("m1")).toBe(false);
    await addBookmark({ ...base, messageId: "m1", text: "중요한 메시지" });
    expect(await isBookmarked("m1")).toBe(true);
    expect(await countBookmarks()).toBe(1);

    const rows = await listBookmarks();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("중요한 메시지");

    await removeBookmark("m1");
    expect(await isBookmarked("m1")).toBe(false);
    expect(await listBookmarks()).toEqual([]);
  });

  it("lists newest saved first and caps text length", async () => {
    await addBookmark({
      ...base,
      messageId: "old",
      text: "오래된 저장",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    await addBookmark({
      ...base,
      messageId: "new",
      text: "새 저장",
      savedAt: "2026-01-02T00:00:00.000Z",
    });
    expect((await listBookmarks()).map((row) => row.messageId)).toEqual(["new", "old"]);
    expect(await listBookmarks(1)).toHaveLength(1);

    await addBookmark({ ...base, messageId: "long", text: "a".repeat(3_000) });
    const long = (await listBookmarks()).find((row) => row.messageId === "long");
    expect(long?.text).toHaveLength(2_000);
  });

  it("keeps attachment bookmarks without text and clears everything", async () => {
    await addBookmark({ ...base, messageId: "file", text: "" });
    expect((await listBookmarks())[0]?.text).toBe("");
    await clearBookmarks();
    expect(await countBookmarks()).toBe(0);
    expect(await isBookmarked("file")).toBe(false);
  });
});
