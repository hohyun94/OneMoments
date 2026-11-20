import { describe, expect, it } from "vitest";

import {
  applyMention,
  mentionQueryAtCursor,
  mentionsUser,
  splitMentions,
} from "./mentions.ts";

describe("mentions", () => {
  it("splits only known participant mentions", () => {
    const segments = splitMentions("안녕 @minsu 그리고 @nobody", ["minsu", "jiyoung"]);
    expect(segments.map((segment) => [segment.text, segment.mention])).toEqual([
      ["안녕 ", false],
      ["@minsu", true],
      [" 그리고 @nobody", false],
    ]);
  });

  it("matches usernames case-insensitively and ignores trailing punctuation", () => {
    const segments = splitMentions("@Alice 확인 부탁", ["alice"]);
    expect(segments[0]).toEqual({ text: "@Alice", mention: true });
    expect(splitMentions("안녕 @alice.", ["alice"]).map((segment) => segment.text)).toEqual([
      "안녕 ",
      "@alice",
      ".",
    ]);
    expect(mentionsUser("@ALICE 확인", "alice")).toBe(true);
    expect(mentionsUser("일반 메시지", "alice")).toBe(false);
  });

  it("supports dot/dash/underscore usernames", () => {
    const segments = splitMentions("@min-su_x.y 알림", ["min-su_x.y"]);
    expect(segments[0]).toEqual({ text: "@min-su_x.y", mention: true });
  });

  it("returns the whole text when nothing matches", () => {
    expect(splitMentions("@nobody 안녕", ["alice"])).toEqual([
      { text: "@nobody 안녕", mention: false },
    ]);
    expect(splitMentions("멘션 없음", [])).toEqual([{ text: "멘션 없음", mention: false }]);
  });

  it("detects an in-progress mention query at the cursor", () => {
    // "안녕 @al" 은 6자(UTF-16) 이다.
    expect(mentionQueryAtCursor("안녕 @al", 6)).toEqual({ query: "al", start: 3 });
    expect(mentionQueryAtCursor("안녕 @", 4)).toEqual({ query: "", start: 3 });
    expect(mentionQueryAtCursor("안녕 alice", 8)).toBeNull();
    expect(mentionQueryAtCursor("@al 안녕", 8)).toBeNull();
  });

  it("replaces the query with the selected username", () => {
    expect(applyMention("안녕 @al", 6, "alice")).toEqual({
      text: "안녕 @alice ",
      cursor: 10,
    });
  });
});
