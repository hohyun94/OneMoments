import { describe, expect, it } from "vitest";

import type { ServerFrame } from "../types.ts";
import {
  callDeclineNote,
  callEndNote,
  callLogLabel,
  cameraFacingLabel,
  cameraFlipLabel,
  canShareScreen,
  countVideoInputs,
  isCallFrame,
  nextCameraFacing,
  normalizeIceServers,
  screenShareLabel,
  videoConstraints,
} from "./call.ts";

describe("call helpers", () => {
  it("detects call frames", () => {
    expect(
      isCallFrame({
        type: "call.invite",
        conversationId: "c",
        callId: "k",
        fromUserId: "u",
        fromDeviceId: "d",
        media: "audio",
        createdAt: "2026-11-23T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(isCallFrame({ type: "pong", at: "now" } as ServerFrame)).toBe(false);
    expect(isCallFrame({ type: "typing", conversationId: "c", userId: "u", state: "start" })).toBe(
      false,
    );
  });

  it("drops ICE servers without urls", () => {
    expect(
      normalizeIceServers([
        { urls: "stun:stun.example.com:3478" },
        { urls: [] },
        { urls: ["turn:turn.example.com:3478"], username: "u", credential: "c" },
      ]),
    ).toEqual([
      { urls: "stun:stun.example.com:3478" },
      { urls: ["turn:turn.example.com:3478"], username: "u", credential: "c" },
    ]);
    expect(normalizeIceServers(undefined)).toEqual([]);
  });

  it("describes end and decline reasons", () => {
    expect(callEndNote(undefined, true)).toBe("상대가 통화를 종료했습니다.");
    expect(callEndNote("hangup", false)).toBe("통화를 종료했습니다.");
    expect(callEndNote("timeout", true)).toBe("응답이 없어 통화를 종료했습니다.");
    expect(callEndNote("failed", true)).toBe("연결에 실패했습니다.");

    expect(callDeclineNote(undefined)).toBe("상대가 통화를 거절했습니다.");
    expect(callDeclineNote("busy")).toBe("상대가 다른 통화 중입니다.");
    expect(callDeclineNote("unsupported")).toBe("상대가 음성 통화를 지원하지 않습니다.");
  });

  it("labels call log entries by direction and status", () => {
    expect(callLogLabel({ status: "completed", direction: "outgoing" })).toBe("발신 통화");
    expect(callLogLabel({ status: "completed", direction: "incoming" })).toBe("수신 통화");
    expect(callLogLabel({ status: "missed", direction: "incoming" })).toBe("부재중 전화");
    expect(callLogLabel({ status: "missed", direction: "outgoing" })).toBe("응답 없음");
    expect(callLogLabel({ status: "declined", direction: "incoming" })).toBe("거절한 통화");
    expect(callLogLabel({ status: "declined", direction: "outgoing" })).toBe("거절됨");
    expect(callLogLabel({ status: "cancelled", direction: "incoming" })).toBe("취소된 통화");
    expect(callLogLabel({ status: "cancelled", direction: "outgoing" })).toBe("취소함");
    expect(callLogLabel({ status: "failed", direction: "outgoing" })).toBe("연결 실패");
    expect(callLogLabel({ status: "ringing", direction: "incoming" })).toBe("연결 중");
    // 영상 통화는 미디어 접두사가 붙는다.
    expect(callLogLabel({ status: "completed", direction: "outgoing", media: "video" })).toBe(
      "영상 발신 통화",
    );
    expect(callLogLabel({ status: "missed", direction: "incoming", media: "video" })).toBe(
      "영상 부재중 전화",
    );
  });

  it("switches camera facing and labels the flip button", () => {
    expect(nextCameraFacing("user")).toBe("environment");
    expect(nextCameraFacing("environment")).toBe("user");
    expect(cameraFacingLabel("user")).toBe("전면 카메라");
    expect(cameraFacingLabel("environment")).toBe("후면 카메라");
    expect(cameraFlipLabel("user")).toBe("후면 카메라로 전환");
    expect(cameraFlipLabel("environment")).toBe("전면 카메라로 전환");
  });

  it("builds video constraints for the requested facing", () => {
    expect(videoConstraints("user")).toEqual({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "user",
    });
    expect(videoConstraints("environment").facingMode).toBe("environment");
  });

  it("counts video inputs and only enables flipping with two or more", () => {
    expect(countVideoInputs([])).toBe(0);
    expect(
      countVideoInputs([
        { kind: "audioinput" },
        { kind: "videoinput" },
      ]),
    ).toBe(1);
    expect(
      countVideoInputs([
        { kind: "videoinput" },
        { kind: "videoinput" },
        { kind: "audioinput" },
      ]),
    ).toBe(2);
  });

  it("labels the screen share action", () => {
    expect(screenShareLabel(false)).toBe("화면 공유");
    expect(screenShareLabel(true)).toBe("화면 공유 중지");
  });

  it("reports screen sharing support from the browser API", () => {
    const original = navigator.mediaDevices;
    try {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getDisplayMedia: () => Promise.reject(new Error("unsupported")) },
      });
      expect(canShareScreen()).toBe(true);
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {},
      });
      expect(canShareScreen()).toBe(false);
    } finally {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: original,
      });
    }
  });
});
