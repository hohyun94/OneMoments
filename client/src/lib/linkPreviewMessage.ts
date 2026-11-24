/**
 * 링크 미리보기가 포함된 메시지 평문.
 *
 * 미리보기 메타데이터(공개 정보)는 **메시지 암호문 안에만** 담는다(서버 저장 없음).
 * 형식: `onemoments:link:v1:<base64(JSON)>`
 */

export const LINK_MESSAGE_PREFIX = "onemoments:link:v1:";

export interface LinkPreviewMeta {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
}

export interface LinkMessagePayload {
  text: string;
  preview: LinkPreviewMeta;
}

function toBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

/** 평문에 링크 미리보기를 붙여 인코딩한다. */
export function encodeLinkMessage(payload: LinkMessagePayload): string {
  return `${LINK_MESSAGE_PREFIX}${toBase64Utf8(JSON.stringify(payload))}`;
}

/** 평문이 링크 메시지면 파싱하고, 아니면 null. */
export function parseLinkMessage(plaintext: string): LinkMessagePayload | null {
  if (!plaintext.startsWith(LINK_MESSAGE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(fromBase64Utf8(plaintext.slice(LINK_MESSAGE_PREFIX.length))) as {
      text?: unknown;
      preview?: { url?: unknown; title?: unknown; description?: unknown; siteName?: unknown };
    };
    const url = typeof parsed.preview?.url === "string" ? parsed.preview.url : "";
    if (!/^https?:\/\//i.test(url)) return null;
    return {
      text: typeof parsed.text === "string" ? parsed.text : "",
      preview: {
        url,
        title: typeof parsed.preview?.title === "string" ? parsed.preview.title : null,
        description:
          typeof parsed.preview?.description === "string" ? parsed.preview.description : null,
        siteName: typeof parsed.preview?.siteName === "string" ? parsed.preview.siteName : null,
      },
    };
  } catch {
    return null;
  }
}

/** 본문에서 첫 http(s) URL 을 찾는다(미리보기 버튼 노출 판단용). */
export function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0].replace(/[),.;!?]+$/, "") : null;
}

/** 표시용 호스트(스킴 제거). */
export function previewHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
