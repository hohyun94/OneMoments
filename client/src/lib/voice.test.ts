import { describe, expect, it } from "vitest";

import {
  formatDuration,
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
});
