/** 무활동 자동 로그아웃 정책. 서버(src/auth/idleTimeout.ts)와 같은 범위를 쓴다. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 5 * 60;
export const MIN_IDLE_TIMEOUT_SECONDS = 60;
export const MAX_IDLE_TIMEOUT_SECONDS = 30 * 60;

/** 설정 UI에서 제시하는 값. 임의 값은 서버 API로도 저장할 수 있다. */
export const IDLE_TIMEOUT_OPTIONS = [
  { seconds: 60, label: "1분" },
  { seconds: 5 * 60, label: "5분" },
  { seconds: 10 * 60, label: "10분" },
  { seconds: 30 * 60, label: "30분" },
] as const;

/** 서버·UI 어디서든 같은 범위로 보정한다. 유효하지 않은 값은 기본값. */
export function clampIdleTimeoutSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_IDLE_TIMEOUT_SECONDS;
  return Math.min(
    MAX_IDLE_TIMEOUT_SECONDS,
    Math.max(MIN_IDLE_TIMEOUT_SECONDS, Math.trunc(value)),
  );
}

/** 세션 오버라이드가 있으면 그 값을, 없으면 기기 기본값을 쓴다. */
export function effectiveIdleTimeoutSeconds(
  deviceSeconds: number,
  sessionSeconds: number | null,
): number {
  return sessionSeconds ?? deviceSeconds;
}

export function idleTimeoutLabel(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}분`;
  return `${seconds}초`;
}
