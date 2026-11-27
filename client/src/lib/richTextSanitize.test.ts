import { describe, expect, it } from "vitest";

import { isDiaryHtmlEmpty, sanitizeDiaryHtml } from "./richTextSanitize.ts";

/**
 * 일기 본문 HTML 새니타이저.
 *
 * 단위 테스트는 **DOM 없는 환경(node)** 에서 돌기 때문에 `document` 가 없다.
 * 이때 새니타이저는 태그를 모두 제거한 텍스트만 돌려준다(안전한 폴백).
 * 허용 목록 기반 정리(script 제거·href 검증 등)는 브라우저에서 실행되므로
 * 여기서는 폴백 경로와 "비어 있음" 판정을 검증한다.
 */
describe("sanitizeDiaryHtml (DOM 없는 환경)", () => {
  it("태그를 제거하고 텍스트만 남긴다", () => {
    expect(sanitizeDiaryHtml("<p>오늘의 <strong>기록</strong></p>")).toBe("오늘의 기록");
  });

  it("script 내용도 텍스트로 노출되지 않도록 태그째 제거한다", () => {
    const cleaned = sanitizeDiaryHtml('<p>안전</p><script>alert(1)</script>');
    expect(cleaned).not.toContain("<");
    expect(cleaned).toContain("안전");
  });

  it("빈 문자열은 빈 문자열", () => {
    expect(sanitizeDiaryHtml("")).toBe("");
  });
});

describe("isDiaryHtmlEmpty", () => {
  it("빈 태그·공백만 있으면 비어 있다고 본다", () => {
    expect(isDiaryHtmlEmpty("<p><br></p>")).toBe(true);
    expect(isDiaryHtmlEmpty("<p>&nbsp;</p>")).toBe(true);
    expect(isDiaryHtmlEmpty("")).toBe(true);
  });

  it("글자가 있으면 비어 있지 않다", () => {
    expect(isDiaryHtmlEmpty("<p>오늘</p>")).toBe(false);
  });
});