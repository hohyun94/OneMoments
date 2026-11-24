import { describe, expect, it } from "vitest";

import { conversationName, filterConversations } from "./conversationFilter.ts";
import type { ConversationSummary } from "../types.ts";

function conversation(input: Partial<ConversationSummary>): ConversationSummary {
  return {
    id: input.id ?? "conv",
    kind: input.kind ?? "direct",
    name: input.name ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    autoDeleteAfterReadSeconds: null,
    peer: input.peer ?? null,
    members: [],
    memberCount: input.memberCount ?? 2,
    muted: false,
    isAdmin: false,
    favorite: false,
    blocked: null,
    unreadCount: input.unreadCount ?? 0,
    missedCallCount: input.missedCallCount ?? 0,
    lastMessageAt: null,
  };
}

const alice = conversation({
  id: "direct-alice",
  peer: { id: "u1", username: "Alice", statusMessage: null, avatarUpdatedAt: null, deleted: false },
});
const group = conversation({ id: "group-study", kind: "group", name: "스터디", memberCount: 5 });
const deletedPeer = conversation({
  id: "direct-deleted",
  peer: { id: "u2", username: null, statusMessage: null, avatarUpdatedAt: null, deleted: true },
});
const unreadGroup = conversation({
  id: "group-unread",
  kind: "group",
  name: "주말 모임",
  unreadCount: 3,
});

const all = [alice, group, deletedPeer, unreadGroup];

describe("conversation filter", () => {
  it("matches conversation titles case-insensitively", () => {
    expect(filterConversations(all, "alice", false).map((item) => item.id)).toEqual([
      "direct-alice",
    ]);
    expect(filterConversations(all, "스터디", false).map((item) => item.id)).toEqual([
      "group-study",
    ]);
  });

  it("falls back to the placeholder name for deleted peers", () => {
    expect(conversationName(deletedPeer)).toBe("삭제된 사용자");
    expect(filterConversations(all, "삭제된", false).map((item) => item.id)).toEqual([
      "direct-deleted",
    ]);
  });

  it("filters unread conversations only", () => {
    expect(filterConversations(all, "", true).map((item) => item.id)).toEqual([
      "group-unread",
    ]);
  });

  it("combines the unread toggle with the query", () => {
    expect(filterConversations(all, "주말", true).map((item) => item.id)).toEqual([
      "group-unread",
    ]);
    expect(filterConversations(all, "스터디", true)).toEqual([]);
  });

  it("returns everything when the query is blank", () => {
    expect(filterConversations(all, "   ", false)).toHaveLength(all.length);
  });
});
