import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  extractLinkMetadata,
  fetchLinkPreview,
  isPrivateAddress,
} from "../src/services/linkPreview.js";

describe("link preview helpers", () => {
  it("detects private and reserved addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.5.4",
      "172.31.255.255",
      "192.168.0.10",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("extracts open graph tags, falling back to title/description", () => {
    const html = `<!doctype html><html><head>
      <title>Fallback &amp; title</title>
      <meta name="description" content="Plain description" />
      <meta property="og:title" content="OneMoments &lt;docs&gt;" />
      <meta property='og:description' content='  Line one
        line two  ' />
      <meta property="og:site_name" content="OneMoments" />
      <meta property="og:image" content="https://evil.example/x.png" />
    </head><body></body></html>`;

    const metadata = extractLinkMetadata(html);
    expect(metadata.title).toBe("OneMoments <docs>");
    expect(metadata.description).toBe("Line one line two");
    expect(metadata.siteName).toBe("OneMoments");

    const fallback = extractLinkMetadata(
      `<html><head><title>제목</title><meta name="description" content="설명"></head></html>`,
    );
    expect(fallback.title).toBe("제목");
    expect(fallback.description).toBe("설명");

    expect(extractLinkMetadata("<html><body>no meta</body></html>")).toEqual({
      title: null,
      description: null,
      siteName: null,
    });
  });
});

describe("fetchLinkPreview", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/article") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(
          `<html><head><meta property="og:title" content="기사 제목">
           <meta property="og:description" content="기사 요약">
           <meta property="og:site_name" content="Example"></head></html>`,
        );
        return;
      }
      if (req.url === "/redirect") {
        res.statusCode = 302;
        res.setHeader("location", "/article");
        res.end();
        return;
      }
      if (req.url === "/json") {
        res.setHeader("content-type", "application/json");
        res.end('{"title":"not html"}');
        return;
      }
      res.statusCode = 404;
      res.end("missing");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reads open graph metadata and follows one redirect", async () => {
    const preview = await fetchLinkPreview({ url: `${baseUrl}/article`, allowPrivate: true });
    expect(preview).toEqual({
      url: `${baseUrl}/article`,
      title: "기사 제목",
      description: "기사 요약",
      siteName: "Example",
    });

    const redirected = await fetchLinkPreview({
      url: `${baseUrl}/redirect`,
      allowPrivate: true,
    });
    expect(redirected?.title).toBe("기사 제목");
  });

  it("rejects non-html, errors, and unsafe schemes", async () => {
    expect(await fetchLinkPreview({ url: `${baseUrl}/json`, allowPrivate: true })).toBeNull();
    expect(await fetchLinkPreview({ url: `${baseUrl}/missing`, allowPrivate: true })).toBeNull();
    expect(await fetchLinkPreview({ url: "file:///etc/passwd", allowPrivate: true })).toBeNull();
    expect(await fetchLinkPreview({ url: "javascript:alert(1)", allowPrivate: true })).toBeNull();
    expect(
      await fetchLinkPreview({ url: "https://user:pass@example.com/", allowPrivate: true }),
    ).toBeNull();
  });

  it("blocks loopback addresses unless explicitly allowed", async () => {
    expect(await fetchLinkPreview({ url: `${baseUrl}/article` })).toBeNull();
  });
});
