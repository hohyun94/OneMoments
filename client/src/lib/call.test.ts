import { describe, expect, it } from "vitest";

import type { ServerFrame } from "../types.ts";
import {
  callDeclineNote,
  callEndNote,
  callLogLabel,
  isCallFrame,
  normalizeIceServers,
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
  });
});
