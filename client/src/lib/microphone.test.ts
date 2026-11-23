import { describe, expect, it } from "vitest";

import {
  classifyMicrophoneError,
  microphoneCapability,
  microphoneStatusLabel,
} from "./microphone.ts";

describe("microphone capability", () => {
  it("requires a secure context and getUserMedia", () => {
    expect(
      microphoneCapability({ isSecureContext: false, hasGetUserMedia: true }),
    ).toBe("insecure");
    expect(
      microphoneCapability({ isSecureContext: true, hasGetUserMedia: false }),
    ).toBe("unsupported");
    expect(
      microphoneCapability({ isSecureContext: true, hasGetUserMedia: true }),
    ).toBe("ready");
  });

  it("classifies getUserMedia failures", () => {
    expect(classifyMicrophoneError({ name: "NotAllowedError" })).toBe("denied");
    expect(classifyMicrophoneError({ name: "SecurityError" })).toBe("denied");
    expect(classifyMicrophoneError({ name: "NotFoundError" })).toBe("not-found");
    expect(classifyMicrophoneError({ name: "NotReadableError" })).toBe("busy");
    expect(classifyMicrophoneError({ name: "NotSupportedError" })).toBe(
      "unsupported",
    );
    expect(classifyMicrophoneError(new Error("boom"))).toBe("error");
    expect(classifyMicrophoneError(null)).toBe("error");
  });

  it("labels statuses for the UI", () => {
    expect(microphoneStatusLabel("available")).toBe("사용 가능");
    expect(microphoneStatusLabel("denied")).toBe("권한이 차단됨");
    expect(microphoneStatusLabel("not-found")).toBe("마이크를 찾을 수 없음");
  });
});
