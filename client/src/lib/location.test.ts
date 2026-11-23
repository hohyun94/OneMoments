import { describe, expect, it } from "vitest";

import {
  encodeLocationPayload,
  formatAccuracy,
  formatCoordinates,
  LOCATION_LABEL_MAX,
  LOCATION_MESSAGE_PREFIX,
  locationMapLink,
  parseLocationPayload,
  type LocationPayload,
} from "./location.ts";

const sample: LocationPayload = {
  lat: 37.5665,
  lng: 126.978,
  accuracy: 15,
  at: "2026-11-23T12:00:00.000Z",
  label: "회사",
};

describe("location payload", () => {
  it("encodes and parses a location inside the encrypted message prefix", () => {
    const encoded = encodeLocationPayload(sample);
    expect(encoded.startsWith(LOCATION_MESSAGE_PREFIX)).toBe(true);
    expect(parseLocationPayload(encoded)).toEqual(sample);
  });

  it("ignores plain text and malformed payloads", () => {
    expect(parseLocationPayload("안녕하세요")).toBeNull();
    expect(parseLocationPayload(`${LOCATION_MESSAGE_PREFIX}%%%not-base64%%%`)).toBeNull();
  });

  it("rejects coordinates outside the valid ranges", () => {
    const encode = (value: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return `${LOCATION_MESSAGE_PREFIX}${btoa(binary)}`;
    };
    expect(parseLocationPayload(encode({ ...sample, lat: 91 }))).toBeNull();
    expect(parseLocationPayload(encode({ ...sample, lng: -181 }))).toBeNull();
    expect(parseLocationPayload(encode({ ...sample, accuracy: -1 }))).toBeNull();
    expect(parseLocationPayload(encode({ ...sample, at: "not-a-date" }))).toBeNull();
    expect(
      parseLocationPayload(encode({ ...sample, label: "가".repeat(LOCATION_LABEL_MAX + 1) })),
    ).toBeNull();
  });

  it("formats coordinates, accuracy and a map link", () => {
    expect(formatCoordinates(sample)).toBe("37.56650, 126.97800");
    expect(formatCoordinates(sample, 2)).toBe("37.57, 126.98");
    expect(formatAccuracy(15)).toBe("정확도 ±15m");
    expect(formatAccuracy(1_500)).toBe("정확도 ±1.5km");
    expect(formatAccuracy(0)).toBe("정확도 미상");

    const link = locationMapLink(sample);
    expect(link.startsWith("https://www.openstreetmap.org/")).toBe(true);
    expect(link).toContain("mlat=37.566500");
    expect(link).toContain("mlon=126.978000");
  });
});
