import { describe, expect, it } from "vitest";

import {
  formatDuration,
  formatPlaybackRate,
  nextPlaybackRate,
  PLAYBACK_RATES,
  pickVoiceMimeType,
  voiceExtension,
  voiceFileName,
} from "./voice.ts";

describe("voice helpers", () => {
  it("picks the first supported mime type", () => {
    expect(pickVoiceMimeType((type) => type === "audio/webm")).toBe("audio/webm");
    expect(pickVoiceMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickVoiceMimeType(() => false)).toBeNull();
  });

  it("maps mime types to extensions", () => {
    expect(voiceExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(voiceExtension("audio/ogg")).toBe("ogg");
    expect(voiceExtension("audio/mp4")).toBe("m4a");
    expect(voiceExtension("audio/unknown")).toBe("webm");
  });

  it("builds a dated file name", () => {
    expect(voiceFileName("audio/webm", new Date(2026, 10, 20, 9, 5))).toBe(
      "음성-20261120-0905.webm",
    );
  });

  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(7)).toBe("0:07");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(3_725)).toBe("1:02:05");
    expect(formatDuration(-3)).toBe("0:00");
  });

  it("cycles playback rates", () => {
    expect(PLAYBACK_RATES).toEqual([1, 1.25, 1.5, 2]);
    expect(nextPlaybackRate(1)).toBe(1.25);
    expect(nextPlaybackRate(1.25)).toBe(1.5);
    expect(nextPlaybackRate(1.5)).toBe(2);
    // 마지막이면 1x 로 돌아오고, 알 수 없는 값도 1x 로 안전하게 처리한다.
    expect(nextPlaybackRate(2)).toBe(1);
    expect(nextPlaybackRate(1.75)).toBe(1);
    expect(formatPlaybackRate(1)).toBe("1x");
    expect(formatPlaybackRate(1.5)).toBe("1.5x");
  });
});
