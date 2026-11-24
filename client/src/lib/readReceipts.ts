/** 읽음 표시 계산(참여자별 시각 포함). 서버 readAt 은 커서 메시지의 작성 시각이다. */

export interface ReadReceiptView {
  userId: string;
  lastReadMessageId: string;
  readAt: string;
  updatedAt: string;
}

export interface ReadReader {
  label: string;
  lastReadMessageId: string;
  readAt: string;
  updatedAt: string;
}

/** 이 메시지를 읽은 사람(내 제외). readAt >= 작성 시각. */
export function readersFor(
  receipts: ReadReceiptView[],
  messageCreatedAt: number,
  currentUserId: string | null,
): ReadReceiptView[] {
  return receipts.filter(
    (receipt) =>
      receipt.userId !== currentUserId && Date.parse(receipt.readAt) >= messageCreatedAt,
  );
}

/**
 * 말풍선에 표시할 읽음 문구와, 참여자별 시각을 담은 상세 문구(툴팁)를 만든다.
 *
 * - 1:1: `읽음 · 오후 8:12`(커서가 이 메시지일 때) / `읽음`
 * - 그룹: 3명 이하 이름 나열, 그 이상 `N명 읽음`
 */
export function describeReads(input: {
  isGroup: boolean;
  readers: ReadReader[];
  messageId: string;
  clock: (iso: string) => string;
}): { label: string; detail: string } {
  const { isGroup, readers, messageId, clock } = input;

  if (readers.length === 0) {
    return { label: "안 읽음", detail: "아직 읽지 않았습니다." };
  }

  const detail = readers
    .map((reader) => `${reader.label} · ${clock(reader.updatedAt)}`)
    .join("\n");

  if (!isGroup) {
    const reader = readers[0];
    if (!reader) return { label: "안 읽음", detail: "아직 읽지 않았습니다." };
    const label =
      reader.lastReadMessageId === messageId
        ? `읽음 · ${clock(reader.updatedAt)}`
        : "읽음";
    return { label, detail };
  }

  const names =
    readers.length <= 3
      ? `${readers.map((reader) => reader.label).join(", ")} 읽음`
      : `${readers.length}명 읽음`;
  const cursors = readers
    .filter((reader) => reader.lastReadMessageId === messageId)
    .map((reader) => Date.parse(reader.updatedAt));
  const latest = cursors.length > 0 ? Math.max(...cursors) : null;
  return {
    label: latest ? `${names} · ${clock(new Date(latest).toISOString())}` : names,
    detail,
  };
}
