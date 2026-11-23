export type DevicePlatform = "ios" | "android" | "mobile" | "desktop" | "unknown";

export interface PlatformInput {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  /** Chromium User-Agent Client Hints 의 mobile 값. */
  userAgentDataMobile?: boolean | null;
}

/**
 * 기기 플랫폼을 best-effort 로 추정한다.
 * UA·플랫폼 문자열은 위조될 수 있으므로 권한·보안 판단에는 쓰지 않는다.
 */
export function detectPlatform(input: PlatformInput): DevicePlatform {
  const ua = input.userAgent;
  const platform = input.platform ?? "";
  const touchPoints = input.maxTouchPoints ?? 0;

  // iPadOS 13+ 는 데스크톱 UA(Macintosh)를 쓰므로 터치 포인트로 보정한다.
  if (
    /^MacIntel$/i.test(platform) &&
    touchPoints > 1 &&
    !/Android/i.test(ua)
  ) {
    return "ios";
  }
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (input.userAgentDataMobile === true) return "mobile";
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua) || /Win32|MacIntel|Linux/i.test(platform)) {
    return "desktop";
  }
  return "unknown";
}

/** 현재 브라우저의 플랫폼을 추정한다. */
export function currentPlatform(): DevicePlatform {
  if (typeof navigator === "undefined") return "unknown";
  const nav = navigator as Navigator & {
    userAgentData?: { mobile?: boolean };
  };
  return detectPlatform({
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    userAgentDataMobile: nav.userAgentData?.mobile ?? null,
  });
}

export function isMobilePlatform(platform: DevicePlatform): boolean {
  return platform === "ios" || platform === "android" || platform === "mobile";
}

export function platformLabel(platform: DevicePlatform): string {
  switch (platform) {
    case "ios":
      return "iOS";
    case "android":
      return "Android";
    case "mobile":
      return "모바일";
    case "desktop":
      return "데스크톱";
    default:
      return "알 수 없음";
  }
}
