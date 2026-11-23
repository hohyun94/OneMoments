export type LocationFailure = "unsupported" | "denied" | "unavailable" | "timeout";

export class LocationRequestError extends Error {
  readonly code: LocationFailure;

  constructor(code: LocationFailure) {
    super(code);
    this.name = "LocationRequestError";
    this.code = code;
  }
}

export interface CurrentLocation {
  lat: number;
  lng: number;
  accuracy: number;
}

type GeolocationLike = Pick<Geolocation, "getCurrentPosition">;

export interface RequestLocationOptions {
  timeoutMs?: number;
  enableHighAccuracy?: boolean;
  /** 테스트 주입용. 기본은 `navigator.geolocation`. */
  geolocation?: GeolocationLike | null;
}

/**
 * 현재 위치를 한 번 읽는다. 브라우저 권한 프롬프트는 이 호출(사용자 제스처 직후)에서만 뜬다.
 * 서버는 위치를 조회할 수 없으므로 항상 클라이언트에서 호출한다.
 */
export function requestCurrentLocation(
  options: RequestLocationOptions = {},
): Promise<CurrentLocation> {
  const { timeoutMs = 10_000, enableHighAccuracy = true } = options;
  const geolocation =
    options.geolocation ??
    (typeof navigator !== "undefined" && navigator.geolocation ? navigator.geolocation : null);
  if (!geolocation) return Promise.reject(new LocationRequestError("unsupported"));

  return new Promise<CurrentLocation>((resolve, reject) => {
    geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      (error) => {
        const code: LocationFailure =
          error.code === 1 ? "denied" : error.code === 3 ? "timeout" : "unavailable";
        reject(new LocationRequestError(code));
      },
      { enableHighAccuracy, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

export function locationFailureMessage(code: LocationFailure): string {
  switch (code) {
    case "unsupported":
      return "이 브라우저에서는 위치를 사용할 수 없습니다.";
    case "denied":
      return "위치 권한이 거부되었습니다. 브라우저 설정에서 이 사이트의 위치 권한을 허용해 주세요.";
    case "timeout":
      return "위치를 확인하는 데 시간이 걸리고 있습니다. 잠시 후 다시 시도해 주세요.";
    default:
      return "현재 위치를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  }
}
