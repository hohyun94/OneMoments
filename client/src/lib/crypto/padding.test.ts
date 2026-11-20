import { describe, expect, it } from "vitest";

import { padPlaintext, unpadPlaintext } from "./padding.ts";

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

describe("message padding", () => {
  it("pads short messages to a fixed bucket size", () => {
    const short = padPlaintext("hi");
    const longer = padPlaintext("안녕하세요, 반갑습니다.");

    expect(byteLength(short)).toBe(256);
    expect(byteLength(longer)).toBe(256);
    // 패딩은 무작위라 같은 길이라도 내용이 다르다.
    expect(short).not.toBe(longer);
  });

  it("round-trips text including newlines and emoji", () => {
    const text = "안녕 👋🏽\n둘째 줄";
    expect(unpadPlaintext(padPlaintext(text))).toBe(text);
    expect(unpadPlaintext(padPlaintext(""))).toBe("");
  });

  it("leaves legacy plaintext untouched", () => {
    expect(unpadPlaintext("그냥 평문")).toBe("그냥 평문");
    expect(unpadPlaintext('{"kind":"attachment"}')).toBe('{"kind":"attachment"}');
  });

  it("keeps padded size under the server ciphertext limit", () => {
    const large = "a".repeat(14_000);
    const padded = padPlaintext(large);

    expect(byteLength(padded)).toBeLessThanOrEqual(15_000);
    expect(unpadPlaintext(padded)).toBe(large);
  });
});
