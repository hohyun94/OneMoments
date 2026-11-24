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

/** 통화 기록 한 줄의 표시 문구(내 기준 방향 + 최종 상태 + 미디어). */
export function callLogLabel(entry: {
  status: "ringing" | "completed" | "missed" | "declined" | "cancelled" | "failed";
  direction: "outgoing" | "incoming";
  media?: "audio" | "video";
}): string {
  const media = entry.media === "video" ? "영상 " : "";
  switch (entry.status) {
    case "missed":
      return entry.direction === "incoming" ? `${media}부재중 전화` : `${media}응답 없음`;
    case "declined":
      return entry.direction === "incoming" ? `${media}거절한 통화` : `${media}거절됨`;
    case "cancelled":
      return entry.direction === "incoming" ? `${media}취소된 통화` : `${media}취소함`;
    case "failed":
      return `${media}연결 실패`;
    case "ringing":
      return `${media}연결 중`;
    default:
      return entry.direction === "incoming" ? `${media}수신 통화` : `${media}발신 통화`;
  }
}

/** 카메라 방향. 모바일에서 전면/후면을 오갈 때 쓴다. */
export type CameraFacing = "user" | "environment";

/** 다음 카메라 방향(전면 ↔ 후면). */
export function nextCameraFacing(current: CameraFacing): CameraFacing {
  return current === "user" ? "environment" : "user";
}

/** 현재 사용 중인 카메라 방향의 표시 이름. */
export function cameraFacingLabel(facing: CameraFacing): string {
  return facing === "user" ? "전면 카메라" : "후면 카메라";
}

/** 카메라 전환 버튼 문구(누르면 바뀔 방향을 알려준다). */
export function cameraFlipLabel(current: CameraFacing): string {
  return current === "user" ? "후면 카메라로 전환" : "전면 카메라로 전환";
}

/** 영상 트랙 제약. 발신 미리보기와 연결 시점이 같은 화질을 쓰도록 한 곳에 둔다. */
export function videoConstraints(facing: CameraFacing): MediaTrackConstraints {
  return { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: facing };
}

/** 비디오 입력 장치 수. 2개 이상일 때만 카메라 전환 버튼을 노출한다. */
export function countVideoInputs(devices: Array<{ kind?: string }>): number {
  return devices.filter((device) => device.kind === "videoinput").length;
}

/** 화면 공유 API 사용 가능 여부(HTTPS/localhost 등 보안 컨텍스트 필요). */
export function canShareScreen(): boolean {
  if (typeof navigator === "undefined") return false;
  return typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

/** 화면 공유 버튼 문구. */
export function screenShareLabel(sharing: boolean): string {
  return sharing ? "화면 공유 중지" : "화면 공유";
}

/**
 * 영상 트랜시버 순서 → 역할.
 *
 * 통화 연결 시 비디오 m-line 을 **카메라(0), 화면(1)** 순서로 미리 협상해 두므로
 * 재협상 없이 화면 트랙만 갈아끼울 수 있다.
 */
export function videoTransceiverRole(videoIndex: number): "camera" | "screen" {
  return videoIndex >= 1 ? "screen" : "camera";
}

/** 상대가 화면을 공유 중일 때의 안내 문구(아니면 빈 문자열). */
export function remoteScreenLabel(sharing: boolean): string {
  return sharing ? "상대가 화면 공유 중" : "";
}

