import { describe, expect, it } from "vitest";

import {
  ALIAS_STORAGE_KEY,
  aliasFor,
  clearAliases,
  loadAliases,
  MAX_ALIAS_LENGTH,
  saveAlias,
} from "./aliases.ts";

function memoryStore(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe("local contact aliases", () => {
  it("stores per-user aliases and trims whitespace", () => {
    const store = memoryStore();
    saveAlias("user-1", "  엄마  ", store);
    saveAlias("user-2", "친구", store);
    expect(loadAliases(store)).toEqual({ "user-1": "엄마", "user-2": "친구" });
  });

  it("removes the alias when saved empty and caps the length", () => {
    const store = memoryStore();
    saveAlias("user-1", "a".repeat(60), store);
    expect(loadAliases(store)["user-1"]).toHaveLength(MAX_ALIAS_LENGTH);
    saveAlias("user-1", "   ", store);
    expect(loadAliases(store)).toEqual({});
    expect(store.getItem(ALIAS_STORAGE_KEY)).toBeNull();
  });

  it("ignores corrupt JSON and clears everything", () => {
    const store = memoryStore();
    store.setItem(ALIAS_STORAGE_KEY, "not-json");
    expect(loadAliases(store)).toEqual({});
    saveAlias("user-1", "별명", store);
    clearAliases(store);
    expect(loadAliases(store)).toEqual({});
    expect(store.getItem(ALIAS_STORAGE_KEY)).toBeNull();
  });

  it("returns an empty alias for unknown users", () => {
    expect(aliasFor(null)).toBe("");
    expect(aliasFor(undefined)).toBe("");
  });
});
