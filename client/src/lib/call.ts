import type { CallServerFrame, ServerFrame } from "../types.ts";

const CALL_FRAME_TYPES = new Set<string>([
  "call.invite",
  "call.accepted",
  "call.declined",
  "call.cancelled",
  "call.ended",
  "call.signal",
]);

/** 서버 프레임이 통화 시그널링인지 판별한다. */
export function isCallFrame(frame: ServerFrame): frame is CallServerFrame {
  return CALL_FRAME_TYPES.has(frame.type);
}

/** ICE 서버 목록에서 빈 URL 을 걸러낸다(설정 누락 방어). */
export function normalizeIceServers(raw: RTCIceServer[] | undefined): RTCIceServer[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((server) => {
    const urls = server.urls;
    return Array.isArray(urls) ? urls.length > 0 : Boolean(urls);
  });
}

/** 통화 종료 사유를 사용자 문구로 바꾼다. */
export function callEndNote(
  reason: "hangup" | "failed" | "timeout" | undefined,
  byPeer: boolean,
): string {
  if (reason === "timeout") return "응답이 없어 통화를 종료했습니다.";
  if (reason === "failed") return "연결에 실패했습니다.";
  return byPeer ? "상대가 통화를 종료했습니다." : "통화를 종료했습니다.";
}

/** 거절 사유 문구. */
export function callDeclineNote(reason: "declined" | "busy" | "unsupported" | undefined): string {
  if (reason === "busy") return "상대가 다른 통화 중입니다.";
  if (reason === "unsupported") return "상대가 음성 통화를 지원하지 않습니다.";
  return "상대가 통화를 거절했습니다.";
}

/** 통화 기록 한 줄의 표시 문구(내 기준 방향 + 최종 상태). */
export function callLogLabel(entry: {
  status: "ringing" | "completed" | "missed" | "declined" | "cancelled" | "failed";
  direction: "outgoing" | "incoming";
}): string {
  switch (entry.status) {
    case "missed":
      return entry.direction === "incoming" ? "부재중 전화" : "응답 없음";
    case "declined":
      return entry.direction === "incoming" ? "거절한 통화" : "거절됨";
    case "cancelled":
      return entry.direction === "incoming" ? "취소된 통화" : "취소함";
    case "failed":
      return "연결 실패";
    case "ringing":
      return "연결 중";
    default:
      return entry.direction === "incoming" ? "수신 통화" : "발신 통화";
  }
}
