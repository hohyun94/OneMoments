/**
 * 첨부 파일 이름 처리.
 *
 * 브라우저·OS 가 원본 파일명을 넘겨주지 못하는 경우가 있다(예: Android 의
 * content:// 선택기, 다른 앱에서 넘어온 캐시 파일 → `tmp_<uuid>.png`).
 * 그런 이름은 사용자에게 의미가 없으므로 날짜 기반 기본 이름으로 바꾸고,
 * 전송 전에 화면에서 직접 수정할 수 있게 한다.
 */
export const ATTACHMENT_NAME_MAX = 255;

const TEMP_NAME_PATTERN = /^tmp[_-]?[0-9a-f]{8,}(-[0-9a-f]{4,})*\.[a-z0-9]{1,10}$/i;
const GENERIC_NAMES = new Set([
  "image",
  "image.png",
  "image.jpg",
  "image.jpeg",
  "blob",
  "blob.png",
  "file",
  "photo",
  "photo.jpg",
  "unnamed",
  "untitled",
]);

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 경로 구분자를 제거하고 길이를 제한한다. */
export function sanitizeAttachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.trim().slice(0, ATTACHMENT_NAME_MAX);
}

/** 임시/일반 이름이라 원본 파일명으로 보기 어려운지 판단한다. */
export function isTemporaryFileName(name: string): boolean {
  const base = sanitizeAttachmentName(name);
  if (!base) return true;
  if (TEMP_NAME_PATTERN.test(base)) return true;
  return GENERIC_NAMES.has(base.toLowerCase());
}

export function attachmentExtension(name: string, mime: string): string {
  const match = /\.([a-z0-9]{1,10})$/i.exec(sanitizeAttachmentName(name));
  if (match?.[1]) return match[1].toLowerCase();
  return MIME_EXTENSIONS[mime.toLowerCase()] ?? "bin";
}

/** 전송 전 기본 이름. 원본이 쓸 만하면 그대로, 아니면 `첨부-YYYYMMDD-HHMM.ext`. */
export function suggestedAttachmentName(
  file: { name: string; type: string; lastModified?: number },
  now: Date = new Date(),
): string {
  const original = sanitizeAttachmentName(file.name);
  if (!isTemporaryFileName(original)) return original;
  const stampDate = new Date(file.lastModified ?? now.getTime());
  const stamp = `${stampDate.getFullYear()}${pad(stampDate.getMonth() + 1)}${pad(
    stampDate.getDate(),
  )}-${pad(stampDate.getHours())}${pad(stampDate.getMinutes())}`;
  return sanitizeAttachmentName(
    `첨부-${stamp}.${attachmentExtension(original, file.type)}`,
  );
}
