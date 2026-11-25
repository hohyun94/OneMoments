import { describe, expect, it } from "vitest";

import { attributionFor, latLngToTile, tilesFor, tileUrlFor } from "./staticMap.ts";

describe("static map tile math", () => {
  it("converts lat/lng to fractional tile coordinates", () => {
    const zero = latLngToTile(0, 0, 1);
    expect(zero.x).toBeCloseTo(1, 6);
    expect(zero.y).toBeCloseTo(1, 6);

    // 경도 → x 는 선형이다(180° 가 타일 범위 끝).
    expect(latLngToTile(0, 180, 2).x).toBeCloseTo(4, 6);
    expect(latLngToTile(0, -180, 2).x).toBeCloseTo(0, 6);

    // 적도보다 북쪽이면 y 가 작다(x 는 경도로만 결정된다).
    const seoul = latLngToTile(37.5665, 126.978, 10);
    const equator = latLngToTile(0, 126.978, 10);
    expect(seoul.y).toBeLessThan(equator.y);
    expect(seoul.y).toBeGreaterThan(0);
    expect(seoul.x).toBeCloseTo(equator.x, 6);
    // 서울은 동경 126.978° → z10 에서 타일 870~874 근처.
    expect(seoul.x).toBeGreaterThan(870);
    expect(seoul.x).toBeLessThan(874);
  });

  it("clamps latitude to the Web Mercator limit", () => {
    const north = latLngToTile(90, 0, 2);
    const clamped = latLngToTile(85.05112878, 0, 2);
    expect(north.y).toBeCloseTo(clamped.y, 6);
    expect(north.y).toBeGreaterThan(-1e-6);
    expect(north.y).toBeLessThan(1e-3);
  });

  it("covers the viewport with a tile range and offsets", () => {
    const range = tilesFor({ lat: 37.5665, lng: 126.978, zoom: 15, width: 480, height: 360 });
    expect(range.zoom).toBe(15);
    expect(range.maxX).toBeGreaterThanOrEqual(range.minX);
    expect(range.maxY).toBeGreaterThanOrEqual(range.minY);
    // 480x360 은 최대 3x3 타일이면 충분하다.
    expect(range.maxX - range.minX).toBeLessThanOrEqual(2);
    expect(range.maxY - range.minY).toBeLessThanOrEqual(2);
    expect(range.offsetX).toBeLessThanOrEqual(0);
    expect(range.offsetY).toBeLessThanOrEqual(0);
  });

  it("substitutes z/x/y and rotates subdomains", () => {
    expect(tileUrlFor("https://t/{z}/{x}/{y}.png", 15, 3, 4)).toBe("https://t/15/3/4.png");
    expect(tileUrlFor("https://{s}.t/{x}/{y}.png", 1, 2, 3)).toBe("https://c.t/2/3.png");
  });

  it("labels OpenStreetMap tiles", () => {
    expect(attributionFor("https://tile.openstreetmap.org/{z}/{x}/{y}.png")).toBe(
      "© OpenStreetMap contributors",
    );
    expect(attributionFor("https://tiles.example.com/{z}/{x}/{y}.png")).toBe("© map tiles");
  });
});
