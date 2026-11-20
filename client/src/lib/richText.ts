/**
 * 메시지 본문의 가벼운 서식 토큰화.
 *
 * 지원: `**굵게**`, `` `인라인 코드` ``, http(s) 링크, @멘션.
 * HTML 을 직접 렌더하지 않고 React 요소로만 그리므로 XSS 위험이 없다.
 * 굵게 안에 링크/멘션을 중첩하는 문법은 지원하지 않는다(문서화된 한계).
 */
export type RichToken =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string }
  | { type: "mention"; text: string };

const MASTER_PATTERN =
  /`([^`\n]{1,200})`|\*\*([^*\n]{1,300})\*\*|(https?:\/\/[^\s<>"']+)|(@[A-Za-z0-9][A-Za-z0-9_.-]{0,31})/g;
const TRAILING_PUNCTUATION = /[.,!?;:)\]}"']+$/;

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function tokenizeMessage(
  text: string,
  mentionNames: string[] = [],
): RichToken[] {
  const mentions = new Set(
    mentionNames.map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0),
  );
  const tokens: RichToken[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(MASTER_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      tokens.push({ type: "text", text: text.slice(lastIndex, start) });
    }

    if (match[1] !== undefined) {
      tokens.push({ type: "code", text: match[1] });
      lastIndex = start + match[0].length;
      continue;
    }
    if (match[2] !== undefined) {
      tokens.push({ type: "bold", text: match[2] });
      lastIndex = start + match[0].length;
      continue;
    }
    if (match[3] !== undefined) {
      const trailing = match[3].match(TRAILING_PUNCTUATION)?.[0] ?? "";
      const urlText = trailing ? match[3].slice(0, -trailing.length) : match[3];
      if (isSafeHttpUrl(urlText)) {
        tokens.push({ type: "link", text: urlText, href: urlText });
      } else {
        tokens.push({ type: "text", text: urlText });
      }
      lastIndex = start + urlText.length;
      if (trailing) {
        tokens.push({ type: "text", text: trailing });
        lastIndex += trailing.length;
      }
      continue;
    }
    if (match[4] !== undefined) {
      const name = match[4].slice(1).toLowerCase();
      tokens.push(
        mentions.has(name)
          ? { type: "mention", text: match[4] }
          : { type: "text", text: match[4] },
      );
      lastIndex = start + match[0].length;
      continue;
    }

    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: "text", text: text.slice(lastIndex) });
  }

  // 인접한 텍스트 토큰은 합쳐 렌더링 조각 수를 줄인다.
  const merged: RichToken[] = [];
  for (const token of tokens) {
    const previous = merged.at(-1);
    if (token.type === "text" && previous?.type === "text") {
      merged[merged.length - 1] = { type: "text", text: previous.text + token.text };
    } else {
      merged.push(token);
    }
  }
  return merged.length > 0 ? merged : [{ type: "text", text }];
}
