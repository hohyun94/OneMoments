export type MicrophoneStatus =
  | "available"
  | "denied"
  | "not-found"
  | "busy"
  | "insecure"
  | "unsupported"
  | "error";

export interface MicrophoneEnvironment {
  isSecureContext: boolean;
  hasGetUserMedia: boolean;
}

/** 마이크를 시도할 수 있는 환경인지 확인한다(실제 장치 확인은 getUserMedia). */
export function microphoneCapability(
  environment: MicrophoneEnvironment,
): "ready" | "insecure" | "unsupported" {
  if (!environment.isSecureContext) return "insecure";
  if (!environment.hasGetUserMedia) return "unsupported";
  return "ready";
}

/** getUserMedia 실패 원인을 사용자 안내용 상태로 분류한다. */
export function classifyMicrophoneError(error: unknown): MicrophoneStatus {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "not-found";
    case "NotReadableError":
    case "AbortError":
      return "busy";
    case "NotSupportedError":
      return "unsupported";
    default:
      return "error";
  }
}

/**
 * 실제 마이크 사용 가능 여부를 확인한다.
 * 반드시 사용자 제스처(버튼 클릭) 안에서 호출하고, 성공 시 트랙을 즉시 중지한다.
 */
export async function checkMicrophone(): Promise<MicrophoneStatus> {
  if (typeof navigator === "undefined") return "unsupported";
  const capability = microphoneCapability({
    isSecureContext:
      typeof window !== "undefined" ? window.isSecureContext : false,
    hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
  });
  if (capability !== "ready") return capability;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return "available";
  } catch (error) {
    return classifyMicrophoneError(error);
  }
}

/** Permissions API 로 마이크 권한 상태를 조회한다(지원 브라우저 한정). */
export async function queryMicrophonePermission(): Promise<
  "granted" | "denied" | "prompt" | "unknown"
> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return "unknown";
  }
  try {
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    return status.state;
  } catch {
    return "unknown";
  }
}

export function microphoneStatusLabel(status: MicrophoneStatus): string {
  switch (status) {
    case "available":
      return "사용 가능";
    case "denied":
      return "권한이 차단됨";
    case "not-found":
      return "마이크를 찾을 수 없음";
    case "busy":
      return "다른 앱이 사용 중";
    case "insecure":
      return "HTTPS(또는 localhost) 필요";
    case "unsupported":
      return "이 브라우저에서 미지원";
    default:
      return "확인 실패";
  }
}
