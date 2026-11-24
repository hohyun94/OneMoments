import { describe, expect, it } from "vitest";

import { describeReads, readersFor, type ReadReceiptView } from "./readReceipts.ts";

const clock = (iso: string) => new Date(iso).toISOString().slice(11, 16);

function receipt(overrides: Partial<ReadReceiptView>): ReadReceiptView {
  return {
    userId: "u1",
    lastReadMessageId: "m1",
    readAt: "2026-01-01T12:00:00.000Z",
    updatedAt: "2026-01-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("read receipt helpers", () => {
  it("counts only readers whose cursor reached the message and excludes me", () => {
    const created = Date.parse("2026-01-01T11:00:00.000Z");
    const readers = readersFor(
      [
        receipt({ userId: "me" }),
        receipt({ userId: "u1", readAt: "2026-01-01T10:59:59.000Z" }),
        receipt({ userId: "u2", readAt: "2026-01-01T11:00:00.000Z" }),
      ],
      created,
      "me",
    );
    expect(readers.map((item) => item.userId)).toEqual(["u2"]);
  });

  it("describes direct reads with the read time when the cursor is this message", () => {
    const readers = [
      { label: "@bob", lastReadMessageId: "m1", readAt: "", updatedAt: "2026-01-01T12:34:00.000Z" },
    ];
    expect(describeReads({ isGroup: false, readers, messageId: "m1", clock })).toEqual({
      label: "읽음 · 12:34",
      detail: "@bob · 12:34",
    });
    expect(
      describeReads({ isGroup: false, readers, messageId: "m2", clock }).label,
    ).toBe("읽음");
    expect(describeReads({ isGroup: false, readers: [], messageId: "m1", clock })).toEqual({
      label: "안 읽음",
      detail: "아직 읽지 않았습니다.",
    });
  });

  it("lists group readers by name up to three and shows per-person times", () => {
    const readers = ["@a", "@b", "@c"].map((label, index) => ({
      label,
      lastReadMessageId: "m1",
      readAt: "",
      updatedAt: `2026-01-01T12:0${index}:00.000Z`,
    }));
    const result = describeReads({ isGroup: true, readers, messageId: "m1", clock });
    expect(result.label).toBe("@a, @b, @c 읽음 · 12:02");
    expect(result.detail.split("\n")).toHaveLength(3);
    expect(result.detail).toContain("@b · 12:01");
  });

  it("summarizes groups with more than three readers", () => {
    const readers = ["@a", "@b", "@c", "@d"].map((label) => ({
      label,
      lastReadMessageId: "m9",
      readAt: "",
      updatedAt: "2026-01-01T12:00:00.000Z",
    }));
    expect(describeReads({ isGroup: true, readers, messageId: "m1", clock }).label).toBe(
      "4명 읽음",
    );
  });
});
