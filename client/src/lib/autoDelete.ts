/** 대화별 자동 삭제 옵션(서버 허용 범위: 1시간~30일). */
export const AUTO_DELETE_OPTIONS = [
  { seconds: null, label: "끔" },
  { seconds: 60 * 60, label: "1시간" },
  { seconds: 24 * 60 * 60, label: "1일" },
  { seconds: 7 * 24 * 60 * 60, label: "7일" },
  { seconds: 30 * 24 * 60 * 60, label: "30일" },
] as const;

export function autoDeleteLabel(seconds: number | null): string {
  if (seconds === null) return "끔";
  if (seconds % (24 * 60 * 60) === 0) return `${seconds / (24 * 60 * 60)}일`;
  if (seconds % (60 * 60) === 0) return `${seconds / (60 * 60)}시간`;
  return `${seconds}초`;
}

/** 삭제 예정 시각(마지막 읽은 시각 + 기간). 표시용. */
export function autoDeleteAt(lastReadAt: Date, seconds: number): Date {
  return new Date(lastReadAt.getTime() + seconds * 1000);
}
