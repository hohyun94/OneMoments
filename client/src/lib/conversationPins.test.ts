import { afterEach, describe, expect, it } from "vitest";

import {
  loadPinnedConversations,
  sortPinnedFirst,
  togglePinnedConversation,
} from "./conversationPins.ts";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe("conversation pins", () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("toggles pins per account", () => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();

    expect(loadPinnedConversations("user-a")).toEqual([]);
    expect(togglePinnedConversation("user-a", "c1")).toEqual(["c1"]);
    expect(togglePinnedConversation("user-a", "c2")).toEqual(["c2", "c1"]);
    // 다른 계정에는 섞이지 않는다.
    expect(loadPinnedConversations("user-b")).toEqual([]);
    expect(togglePinnedConversation("user-a", "c1")).toEqual(["c2"]);
  });

  it("sorts pinned conversations first without changing the rest", () => {
    const list = [{ id: "c1" }, { id: "c2" }, { id: "c3" }];
    expect(sortPinnedFirst(list, ["c3"])).toEqual([{ id: "c3" }, { id: "c1" }, { id: "c2" }]);
    expect(sortPinnedFirst(list, [])).toEqual(list);
  });

  it("is a no-op without localStorage", () => {
    expect(loadPinnedConversations("user-a")).toEqual([]);
    expect(() => togglePinnedConversation("user-a", "c1")).not.toThrow();
  });
});
