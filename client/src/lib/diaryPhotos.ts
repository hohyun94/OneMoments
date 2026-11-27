import { decryptAttachment, encryptAttachment } from "./crypto/attachment.ts";
import { getCsrfToken } from "./api.ts";

/**
 * 일기 사진(암호문) 업로드·복호화.
 *
 * - 이미지는 `encryptAttachment` 로 AES-GCM 암호화하고 **암호문만** 서버로 보낸다.
 * - 복호화 키·IV 는 글 본문 payload(JSON) 안에만 넣는다 → 대상자 기기 봉투로 함께 보호된다.
 * - 서버는 크기만 알며, 다운로드는 일기장 멤버만 가능하다.
 */

export interface DiaryPhotoRef {
  id: string;
  key: string;
  iv: string;
  mime: string;
}

export interface DiaryEntryPayload {
  v: 1;
  html: string;
  photos: DiaryPhotoRef[];
}

/** 본문 payload 인코딩(에디터 HTML + 사진 참조). */
export function encodeDiaryPayload(payload: DiaryEntryPayload): string {
  return JSON.stringify(payload);
}

/** payload 파싱. 구버전(HTML 문자열만) 글은 사진 없이 그대로 돌려준다. */
export function parseDiaryPayload(raw: string): DiaryEntryPayload {
  if (raw.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Partial<DiaryEntryPayload>;
      if (parsed.v === 1 && typeof parsed.html === "string" && Array.isArray(parsed.photos)) {
        return { v: 1, html: parsed.html, photos: parsed.photos };
      }
    } catch {
      // JSON 이 아니면 예전 형식(HTML)으로 본다.
    }
  }
  return { v: 1, html: raw, photos: [] };
}

/** 사진 1장 암호화 후 업로드. 응답의 id 와 로컬 키/IV 를 묶어 참조를 만든다. */
export async function uploadDiaryPhoto(input: {
  file: File;
  clientEntryId: string;
}): Promise<DiaryPhotoRef> {
  const encrypted = await encryptAttachment(input.file);
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "x-diary-entry-id": input.clientEntryId,
  };
  const csrf = getCsrfToken();
  if (csrf) headers["x-csrf-token"] = csrf;

  const response = await fetch("/api/diaries/attachments", {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: new Blob([encrypted.ciphertext], { type: "application/octet-stream" }),
  });
  if (!response.ok) {
    throw new Error("사진을 올리지 못했습니다.");
  }
  const data = (await response.json()) as { attachment: { id: string; size: number } };
  return {
    id: data.attachment.id,
    key: encrypted.key,
    iv: encrypted.iv,
    mime: input.file.type || "application/octet-stream",
  };
}

/**
 * 본문 HTML 의 `data-diary-photo` 참조를 실제 blob URL 로 치환한다.
 *
 * 반드시 **새니타이즈 전에** 호출해야 한다(새니타이저는 src 없는 img 를 제거하고,
 * blob: 만 허용하므로 순서를 바꾸면 사진이 사라진다).
 */
export function inlineDiaryPhotoUrls(html: string, urls: Map<string, string>): string {
  return html.replace(
    /<img([^>]*?)data-diary-photo="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"([^>]*?)>/gi,
    (match, before: string, id: string, after: string) => {
      const url = urls.get(id.toLowerCase());
      if (!url) return "";
      const head = before.replace(/\s*src="[^"]*"/gi, "");
      const tail = after.replace(/\s*src="[^"]*"/gi, "");
      return `<img${head} src="${url}"${tail}>`;
    },
  );
}

export async function loadDiaryPhoto(ref: DiaryPhotoRef): Promise<string> {
  const response = await fetch(`/api/diaries/attachments/${ref.id}`, {
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error("사진을 불러오지 못했습니다.");
  }
  const ciphertext = await response.arrayBuffer();
  const plain = await decryptAttachment(ciphertext, ref.key, ref.iv);
  return URL.createObjectURL(new Blob([plain], { type: ref.mime }));
}
