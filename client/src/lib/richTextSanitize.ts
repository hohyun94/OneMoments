/**
 * 리치 텍스트 HTML 새니타이저(의존성 0).
 *
 * 일기 본문은 E2E 로 암호화되어 오가지만, **복호화한 HTML 을 그대로 DOM 에 넣으면**
 * 상대가 심은 스크립트/이벤트 핸들러가 실행될 수 있다. 그래서 렌더 직전에 허용 목록으로 걸러낸다.
 *
 * - 허용 태그: 문단·제목·목록·인용·코드·강조·링크·줄바꿈
 * - 허용 속성: `a[href]`(http/https/mailto 만), `class`는 허용 접두사(`diary-`)만
 * - 위험 요소(`script`/`style`/`iframe`/`object`/`embed`), `on*` 핸들러, `javascript:` URL 은 제거
 */

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "div",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "mark",
  "h2",
  "h3",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "hr",
  "a",
]);

const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "svg",
  "math",
  "video",
  "audio",
  "source",
  "canvas",
]);

function safeHref(raw: string): string | null {
  const value = raw.trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  return null;
}

/**
 * 허용 목록 기반으로 HTML 을 정리한다.
 * 브라우저에는 `<template>` 안에서 파싱해 **스크립트를 실행하지 않고** 노드를 걷어낸다.
 */
export function sanitizeDiaryHtml(html: string): string {
  if (typeof document === "undefined") {
    // 서버/테스트(jsdom 없음) 환경: 태그를 모두 제거한 텍스트만 돌려준다.
    return html.replace(/<[^>]*>/g, "").trim();
  }
  const template = document.createElement("template");
  template.innerHTML = html;

  const walk = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove();
        continue;
      }
      const element = child as HTMLElement;
      const tag = element.tagName.toLowerCase();

      if (DROP_WITH_CONTENT.has(tag)) {
        element.remove();
        continue;
      }
      if (!ALLOWED_TAGS.has(tag)) {
        // 태그만 벗기고 내용(자식)은 살린다(예: <section><p>…</p></section>).
        const parent = element.parentNode;
        if (!parent) continue;
        while (element.firstChild) parent.insertBefore(element.firstChild, element);
        element.remove();
        continue;
      }

      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (tag === "a" && name === "href") {
          const href = safeHref(attribute.value);
          if (!href) element.removeAttribute("href");
          else element.setAttribute("href", href);
          continue;
        }
        if (tag === "a" && (name === "target" || name === "rel")) continue;
        if (name === "class" && attribute.value.split(/\s+/).every((token) => token.startsWith("diary-"))) {
          continue;
        }
        element.removeAttribute(attribute.name);
      }
      if (tag === "a" && element.getAttribute("href")) {
        element.setAttribute("rel", "noopener noreferrer");
        element.setAttribute("target", "_blank");
      }
      walk(element);
    }
  };

  walk(template.content);
  return template.innerHTML;
}

/** 에디터 본문이 비어 있는지(공백·빈 태그만 있는 경우). */
export function isDiaryHtmlEmpty(html: string): boolean {
  const text = html
    .replace(/<br\s*\/?>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .trim();
  return text.length === 0;
}
