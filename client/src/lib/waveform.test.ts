import { describe, expect, it } from "vitest";

import { WAVEFORM_BARS, peaksFromChannelData } from "./waveform.ts";

describe("waveform peaks", () => {
  it("returns a fixed number of bars", () => {
    const peaks = peaksFromChannelData(new Float32Array(1_000).fill(0.5));
    expect(peaks).toHaveLength(WAVEFORM_BARS);
    expect(peaks.every((value) => value === 50)).toBe(true);
  });

  it("clamps loud and silent samples", () => {
    const data = new Float32Array(96);
    data.fill(0);
    data[0] = 2; // 1.0 초과
    const peaks = peaksFromChannelData(data, 2);
    expect(peaks[0]).toBe(100);
    expect(peaks[1]).toBe(3);
  });

  it("handles empty input", () => {
    expect(peaksFromChannelData(new Float32Array(0), 4)).toEqual([3, 3, 3, 3]);
  });
});
