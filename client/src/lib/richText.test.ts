import { describe, expect, it } from "vitest";

import { tokenizeMessage } from "./richText.ts";

describe("rich text tokenizer", () => {
  it("splits bold, inline code, links and mentions", () => {
    const tokens = tokenizeMessage(
      "**중요** 그리고 `npm test` https://example.com @minsu",
      ["minsu"],
    );
    expect(tokens).toEqual([
      { type: "bold", text: "중요" },
      { type: "text", text: " 그리고 " },
      { type: "code", text: "npm test" },
      { type: "text", text: " " },
      { type: "link", text: "https://example.com", href: "https://example.com" },
      { type: "text", text: " " },
      { type: "mention", text: "@minsu" },
    ]);
  });

  it("keeps unknown mentions and plain text as text", () => {
    expect(tokenizeMessage("@nobody 확인", ["minsu"])).toEqual([
      { type: "text", text: "@nobody 확인" },
    ]);
    expect(tokenizeMessage("일반 메시지", [])).toEqual([
      { type: "text", text: "일반 메시지" },
    ]);
  });

  it("separates trailing punctuation from links", () => {
    expect(tokenizeMessage("참고: https://example.com.")).toEqual([
      { type: "text", text: "참고: " },
      { type: "link", text: "https://example.com", href: "https://example.com" },
      { type: "text", text: "." },
    ]);
  });

  it("only treats http(s) urls as links", () => {
    const tokens = tokenizeMessage("javascript:alert(1) http://ok.test");
    expect(tokens).toEqual([
      { type: "text", text: "javascript:alert(1) " },
      { type: "link", text: "http://ok.test", href: "http://ok.test" },
    ]);
  });

  it("keeps unclosed markers as plain text", () => {
    expect(tokenizeMessage("**안 닫힘")).toEqual([{ type: "text", text: "**안 닫힘" }]);
    expect(tokenizeMessage("`코드")).toEqual([{ type: "text", text: "`코드" }]);
  });

  it("does not treat bold markers inside code as formatting", () => {
    expect(tokenizeMessage("`**not bold**`")).toEqual([
      { type: "code", text: "**not bold**" },
    ]);
  });
});
