import { encoder } from "./encoding.ts";

/**
 * 메시지 길이 메타데이터 완화용 패딩.
 *
 * - 평문을 256/1024/4096/16384 바이트 버킷에 맞춰 **고정 길이**로 만든 뒤 암호화한다.
 *   서버·네트워크 관찰자가 암호문 길이로 짧은 메시지의 대략적 길이를 알기 어려워진다.
 * - 복호화 시 마커가 없으면(패딩 이전 버전 메시지) 그대로 돌려주므로 하위 호환이 유지된다.
 */
const MARKER = "om-pad-1:";
const BUCKETS = [256, 1024, 4096] as const;
/** 서버 기본 암호문 한도(16KB)에 걸리지 않도록 큰 메시지는 이 크기까지만 패딩한다. */
const MAX_PADDED_BYTES = 15_000;
const LARGE_BUCKET_STEP = 1024;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 패딩 목표 크기. null 이면 패딩하지 않는다(한도 초과 방지). */
function bucketFor(size: number): number | null {
  const fixed = BUCKETS.find((bucket) => bucket >= size);
  if (fixed) return fixed;
  const rounded = Math.ceil(size / LARGE_BUCKET_STEP) * LARGE_BUCKET_STEP;
  return rounded <= MAX_PADDED_BYTES ? rounded : null;
}

function randomPad(length: number): string {
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return output;
}

export function padPlaintext(plaintext: string): string {
  const overhead = encoder.encode(
    `${MARKER}{"t":${JSON.stringify(plaintext)},"p":""}`,
  ).length;
  const target = bucketFor(overhead);
  if (target === null) return plaintext;
  const padLength = Math.max(0, target - overhead);
  return `${MARKER}${JSON.stringify({ t: plaintext, p: randomPad(padLength) })}`;
}

export function unpadPlaintext(value: string): string {
  if (!value.startsWith(MARKER)) return value;
  try {
    const parsed = JSON.parse(value.slice(MARKER.length)) as { t?: unknown };
    return typeof parsed.t === "string" ? parsed.t : value;
  } catch {
    return value;
  }
}
