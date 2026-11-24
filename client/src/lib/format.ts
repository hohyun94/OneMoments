export function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatListTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return formatClock(value);
  return date.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDayLabel(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return "오늘";
  if (date.toDateString() === yesterday.toDateString()) return "어제";
  return date.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * 마지막 접속 등 "얼마 전"을 표시한다.
 *
 * - 1분 미만: "방금 전"
 * - 60분 미만: "N분 전"
 * - 24시간 미만: "N시간 전"
 * - 그 외: "N일 전"
 * 미래 시각(시계 오차)은 "방금 전"으로 처리한다.
 */
export function formatRelativeTime(value: string, now: number = Date.now()): string {
  const target = Date.parse(value);
  if (Number.isNaN(target)) return "";
  const diffMs = now - target;
  if (diffMs < 60_000) return "방금 전";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}
