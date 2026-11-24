import { describe, expect, it } from "vitest";

import {
  encodeLinkMessage,
  extractFirstUrl,
  parseLinkMessage,
  previewHost,
} from "./linkPreviewMessage.ts";

describe("link preview message", () => {
  const preview = {
    url: "https://example.com/post?utm=1",
    title: "제목",
    description: "설명",
    siteName: "Example",
  };

  it("round-trips a link preview payload", () => {
    const encoded = encodeLinkMessage({ text: "이거 봐 https://example.com/post?utm=1", preview });
    expect(encoded.startsWith("onemoments:link:v1:")).toBe(true);
    expect(parseLinkMessage(encoded)).toEqual({
      text: "이거 봐 https://example.com/post?utm=1",
      preview,
    });
  });

  it("ignores plain text and malformed payloads", () => {
    expect(parseLinkMessage("그냥 텍스트")).toBeNull();
    expect(parseLinkMessage("onemoments:link:v1:%%%")).toBeNull();
    // URL 이 http(s) 가 아니면 버린다.
    const bad = `onemoments:link:v1:${btoa(
      JSON.stringify({ text: "x", preview: { url: "javascript:alert(1)" } }),
    )}`;
    expect(parseLinkMessage(bad)).toBeNull();
  });

  it("extracts the first url and trims trailing punctuation", () => {
    expect(extractFirstUrl("링크: https://a.example/x, 그리고 https://b.example")).toBe(
      "https://a.example/x",
    );
    expect(extractFirstUrl("(https://c.example/y).")).toBe("https://c.example/y");
    expect(extractFirstUrl("URL 없음")).toBeNull();
    expect(previewHost("https://example.com:8443/path")).toBe("example.com:8443");
  });
});
