/**
 * 무활동 자동 로그아웃 정책.
 *
 * - 기기별 기본값(devices.idle_timeout_seconds)과 세션별 오버라이드(sessions.idle_timeout_seconds)를 둔다.
 * - 세션 오버라이드가 있으면 그 값이 우선한다.
 * - 보안 계약상 "끄기(무제한)"는 허용하지 않고, 서버가 범위를 강제한다.
 */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 5 * 60;
export const MIN_IDLE_TIMEOUT_SECONDS = 60;
export const MAX_IDLE_TIMEOUT_SECONDS = 30 * 60;

/** 저장 전에 범위를 보정한다. 유효하지 않은 값은 기본값으로 되돌린다. */
export function clampIdleTimeoutSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_IDLE_TIMEOUT_SECONDS;
  return Math.min(
    MAX_IDLE_TIMEOUT_SECONDS,
    Math.max(MIN_IDLE_TIMEOUT_SECONDS, Math.trunc(value)),
  );
}
