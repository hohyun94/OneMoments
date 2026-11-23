import { decoder, encoder, fromBase64, toBase64 } from "./crypto/encoding.ts";

/**
 * 위치 공유 메시지는 첨부와 같은 방식으로 **암호문(평문) 안에** 접두사+base64(JSON) 로 담는다.
 * 서버는 이 문자열을 복호화할 수 없으므로 좌표는 서버에 남지 않는다(기기 간 E2E).
 */
export const LOCATION_MESSAGE_PREFIX = "onemoments:location:v1:";
export const LOCATION_LABEL_MAX = 80;
/** 좌표 표시 소수 자리수(5자리 ≈ 1m 수준). */
export const LOCATION_COORDINATE_DIGITS = 5;

export interface LocationPayload {
  lat: number;
  lng: number;
  /** 측정 정확도(미터). 0 이면 미상. */
  accuracy: number;
  /** 측정 시각(ISO 8601). */
  at: string;
  /** 사용자가 붙인 장소 이름(예: "집"). */
  label?: string;
}

/** 위치 카드·미리보기가 좌표 계산에만 쓰는 최소 정보. */
export interface SharedLocation {
  lat: number;
  lng: number;
  accuracy: number;
}

export function encodeLocationPayload(location: LocationPayload): string {
  return `${LOCATION_MESSAGE_PREFIX}${toBase64(encoder.encode(JSON.stringify(location)))}`;
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** 복호화된 본문이 위치 공유 payload 이면 검증 후 반환한다. 형식이 어긋나면 null(일반 텍스트로 취급). */
export function parseLocationPayload(content: string): LocationPayload | null {
  if (!content.startsWith(LOCATION_MESSAGE_PREFIX)) return null;
  try {
    const raw = decoder.decode(fromBase64(content.slice(LOCATION_MESSAGE_PREFIX.length)));
    const value = JSON.parse(raw) as Partial<LocationPayload>;
    if (!isFiniteInRange(value.lat, -90, 90)) return null;
    if (!isFiniteInRange(value.lng, -180, 180)) return null;
    if (!isFiniteInRange(value.accuracy, 0, 100_000)) return null;
    if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) return null;
    if (value.label !== undefined) {
      if (typeof value.label !== "string" || value.label.length > LOCATION_LABEL_MAX) return null;
    }
    return {
      lat: value.lat,
      lng: value.lng,
      accuracy: value.accuracy,
      at: value.at,
      ...(value.label ? { label: value.label } : {}),
    };
  } catch {
    return null;
  }
}

export function formatCoordinates(location: SharedLocation, digits = LOCATION_COORDINATE_DIGITS): string {
  const precision = Math.min(8, Math.max(0, Math.trunc(digits)));
  return `${location.lat.toFixed(precision)}, ${location.lng.toFixed(precision)}`;
}

export function formatAccuracy(accuracy: number): string {
  if (!Number.isFinite(accuracy) || accuracy <= 0) return "정확도 미상";
  if (accuracy < 1_000) return `정확도 ±${Math.round(accuracy)}m`;
  return `정확도 ±${(accuracy / 1_000).toFixed(1)}km`;
}

/** 외부 지도(OpenStreetMap)로 연다. 지도를 임베드하지 않아 CSP·프라이버시 영향이 없다. */
export function locationMapLink(location: SharedLocation): string {
  const lat = location.lat.toFixed(6);
  const lng = location.lng.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}
