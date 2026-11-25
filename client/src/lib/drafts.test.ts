import { describe, expect, it } from "vitest";

import {
  clearAllDrafts,
  clearDraft,
  DRAFT_STORAGE_KEY,
  loadDraft,
  saveDraft,
} from "./drafts.ts";

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

describe("conversation drafts", () => {
  it("stores and loads a draft per conversation", () => {
    const store = memoryStore();
    expect(loadDraft("c1", store)).toBe("");
    saveDraft("c1", "안녕", store);
    saveDraft("c2", "두번째", store);
    expect(loadDraft("c1", store)).toBe("안녕");
    expect(loadDraft("c2", store)).toBe("두번째");
  });

  it("removes the key when the draft is emptied", () => {
    const store = memoryStore();
    saveDraft("c1", "메모", store);
    expect(store.getItem(DRAFT_STORAGE_KEY)).toContain("메모");
    clearDraft("c1", store);
    expect(loadDraft("c1", store)).toBe("");
    // 마지막 초안을 지우면 저장 키 자체를 없앤다.
    expect(store.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("ignores corrupt JSON and clears everything on demand", () => {
    const store = memoryStore();
    store.setItem(DRAFT_STORAGE_KEY, "{not json");
    expect(loadDraft("c1", store)).toBe("");
    saveDraft("c1", "복구", store);
    clearAllDrafts(store);
    expect(store.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("caps overly long drafts", () => {
    const store = memoryStore();
    saveDraft("c1", "a".repeat(5_000), store);
    expect(loadDraft("c1", store).length).toBe(4_000);
  });
});
