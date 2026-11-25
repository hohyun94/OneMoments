/**
 * 음성 메시지 녹음 유틸.
 *
 * 서버는 트랜스코딩하지 않으므로(암호문만 저장) 브라우저가 만든 Opus/기타 포맷을 그대로 쓴다.
 * 길이를 5분으로 제한해 파일이 5MB 상한 안에 들어오게 한다(Opus 32kbps 기준 약 1.2MB).
 */
export const MAX_VOICE_SECONDS = 5 * 60;

/** 브라우저가 지원하는 첫 번째 음성 MIME. 하나도 없으면 null. */
export function pickVoiceMimeType(isSupported: (type: string) => boolean): string | null {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const candidate of candidates) {
    if (isSupported(candidate)) return candidate;
  }
  return null;
}

/** MIME에 맞는 확장자. */
export function voiceExtension(mime: string): string {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "audio/webm") return "webm";
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/mp4") return "m4a";
  if (base === "audio/mpeg") return "mp3";
  if (base === "audio/wav" || base === "audio/x-wav") return "wav";
  return "webm";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 예: 음성-20261120-0905.webm */
export function voiceFileName(mime: string, at: Date = new Date()): string {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(
    at.getHours(),
  )}${pad(at.getMinutes())}`;
  return `음성-${stamp}.${voiceExtension(mime)}`;
}

/** 재생/녹음 표시용 mm:ss (1시간 이상은 h:mm:ss). */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(rest)}`;
  return `${minutes}:${pad(rest)}`;
}

/** 음성 재생 배속 후보. 길게 듣기 싫은 음성 메시지를 빨리 넘길 때 쓴다. */
export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

/** 다음 배속(마지막이면 1x 로 돌아온다). */
export function nextPlaybackRate(current: number): number {
  const index = PLAYBACK_RATES.indexOf(current as (typeof PLAYBACK_RATES)[number]);
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? 1;
}

/** 배속 표시(1 → "1x"). */
export function formatPlaybackRate(rate: number): string {
  return `${rate}x`;
}
