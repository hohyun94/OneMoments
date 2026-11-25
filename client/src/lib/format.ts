import { DEFAULT_LOCALE, translate, type Locale } from "./i18n.ts";

/**
 * 날짜·시간 표기. 로케일을 넘기지 않으면 한국어(ko-KR)로 표기한다.
 * 상대 시간·오늘/어제 문구는 i18n 사전(`time.*`)을 사용한다.
 */
const LOCALE_TAGS: Record<Locale, string> = { ko: "ko-KR", en: "en-US" };

export function formatClock(value: string, locale: Locale = DEFAULT_LOCALE): string {
  return new Date(value).toLocaleTimeString(LOCALE_TAGS[locale], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatListTime(
  value: string | null,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return formatClock(value, locale);
  return date.toLocaleDateString(LOCALE_TAGS[locale], {
    month: "short",
    day: "numeric",
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDayLabel(value: string, locale: Locale = DEFAULT_LOCALE): string {
  const date = new Date(value);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return translate(locale, "time.today");
  if (date.toDateString() === yesterday.toDateString())
    return translate(locale, "time.yesterday");
  return date.toLocaleDateString(LOCALE_TAGS[locale], {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * 마지막 접속 등 "얼마 전"을 표시한다.
 *
 * - 1분 미만: "방금 전" / "just now"
 * - 60분 미만: "N분 전"
 * - 24시간 미만: "N시간 전"
 * - 그 외: "N일 전"
 * 미래 시각(시계 오차)은 "방금 전"으로 처리한다.
 */
export function formatRelativeTime(
  value: string,
  now: number = Date.now(),
  locale: Locale = DEFAULT_LOCALE,
): string {
  const target = Date.parse(value);
  if (Number.isNaN(target)) return "";
  const diffMs = now - target;
  if (diffMs < 60_000) return translate(locale, "time.justNow");
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return translate(locale, "time.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate(locale, "time.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return translate(locale, "time.daysAgo", { count: days });
}
