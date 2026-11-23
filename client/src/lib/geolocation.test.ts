import { describe, expect, it } from "vitest";

import {
  LocationRequestError,
  locationFailureMessage,
  requestCurrentLocation,
  type LocationFailure,
} from "./geolocation.ts";

function position(lat: number, lng: number, accuracy: number): GeolocationPosition {
  return {
    coords: {
      latitude: lat,
      longitude: lng,
      accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON: () => ({}),
    },
    timestamp: Date.now(),
    toJSON: () => ({}),
  };
}

function failure(code: number): GeolocationPositionError {
  return {
    code,
    message: "test",
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  };
}

describe("requestCurrentLocation", () => {
  it("resolves coordinates and requests high accuracy", async () => {
    let seen: PositionOptions | undefined;
    const geolocation = {
      getCurrentPosition: (
        success: PositionCallback,
        _error?: PositionErrorCallback | null,
        options?: PositionOptions,
      ) => {
        seen = options;
        success(position(37.5, 127.1, 12));
      },
    };

    await expect(requestCurrentLocation({ geolocation })).resolves.toEqual({
      lat: 37.5,
      lng: 127.1,
      accuracy: 12,
    });
    expect(seen?.enableHighAccuracy).toBe(true);
    expect(seen?.maximumAge).toBe(0);
  });

  it("maps browser errors to typed failures", async () => {
    const mapping: Array<[number, LocationFailure]> = [
      [1, "denied"],
      [2, "unavailable"],
      [3, "timeout"],
    ];
    for (const [browserCode, expected] of mapping) {
      const geolocation = {
        getCurrentPosition: (
          _success: PositionCallback,
          error?: PositionErrorCallback | null,
        ) => {
          error?.(failure(browserCode));
        },
      };
      await expect(requestCurrentLocation({ geolocation })).rejects.toMatchObject({
        name: "LocationRequestError",
        code: expected,
      });
    }
  });

  it("reports unsupported when geolocation is missing", async () => {
    await expect(requestCurrentLocation({ geolocation: null })).rejects.toBeInstanceOf(
      LocationRequestError,
    );
  });

  it("has a Korean message per failure", () => {
    expect(locationFailureMessage("denied")).toContain("권한");
    expect(locationFailureMessage("timeout")).toContain("시간");
    expect(locationFailureMessage("unsupported")).toContain("브라우저");
    expect(locationFailureMessage("unavailable")).toContain("위치");
  });
});
