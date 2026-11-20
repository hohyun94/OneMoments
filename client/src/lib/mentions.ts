/**
 * @멘션 표시·자동완성 유틸.
 *
 * 멘션은 별도 메타데이터 없이 본문의 `@username` 토큰으로만 표현한다(서버는 여전히 암호문만 보관).
 * 참여자 username 목록과 일치하는 토큰만 멘션으로 강조한다.
 */
export interface MentionSegment {
  text: string;
  mention: boolean;
}

const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_.-]{0,31})/g;
const QUERY_PATTERN = /(?:^|\s)@([A-Za-z0-9_.-]{0,32})$/;

export function splitMentions(text: string, names: string[]): MentionSegment[] {
  const valid = new Set(
    names.map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0),
  );
  if (valid.size === 0 || !text.includes("@")) return [{ text, mention: false }];

  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const raw = match[1] ?? "";
    // 문장부호(. -)로 끝나는 경우는 멘션 토큰에서 제외한다.
    const name = raw.replace(/[.-]+$/, "").toLowerCase();
    if (!valid.has(name)) continue;
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ text: text.slice(lastIndex, start), mention: false });
    }
    segments.push({ text: `@${raw.slice(0, name.length)}`, mention: true });
    lastIndex = start + 1 + name.length;
  }
  if (lastIndex === 0) return [{ text, mention: false }];
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), mention: false });
  }
  return segments;
}

export function mentionsUser(text: string, username: string): boolean {
  return splitMentions(text, [username]).some((segment) => segment.mention);
}

/** 커서 바로 앞이 "@query" 형태면 자동완성 후보를 위한 질의를 돌려준다. */
export function mentionQueryAtCursor(
  text: string,
  cursor: number,
): { query: string; start: number } | null {
  const before = text.slice(0, cursor);
  const match = QUERY_PATTERN.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  return { query, start: cursor - query.length - 1 };
}

/** "@query" 부분을 "@username " 으로 치환하고 새 커서 위치를 돌려준다. */
export function applyMention(
  text: string,
  cursor: number,
  username: string,
): { text: string; cursor: number } {
  const found = mentionQueryAtCursor(text, cursor);
  const start = found ? found.start : cursor;
  const next = `@${username} `;
  return {
    text: `${text.slice(0, start)}${next}${text.slice(cursor)}`,
    cursor: start + next.length,
  };
}
