/** 공개 프로필 아바타 헬퍼(업로드 검증·URL·이니셜). */

export const AVATAR_ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** 클라이언트가 받아들이는 원본 이미지 상한. */
export const AVATAR_MAX_INPUT_BYTES = 8 * 1024 * 1024;
/** 서버로 올리는 정사각 썸네일 크기(px). 128px JPEG ≈ 10~20KB. */
export const AVATAR_OUTPUT_SIZE = 128;

export type AvatarPayload = { mime: "image/jpeg"; data: string };

/** 파일 형식·크기 검증. 문제가 있으면 사용자 문구를 돌려준다. */
export function validateAvatarFile(file: { type: string; size: number }): string | null {
  if (!(AVATAR_ALLOWED_TYPES as readonly string[]).includes(file.type)) {
    return "PNG·JPEG·WebP 이미지만 올릴 수 있습니다.";
  }
  if (file.size > AVATAR_MAX_INPUT_BYTES) {
    return "이미지는 8MB 이하만 올릴 수 있습니다.";
  }
  if (file.size === 0) return "빈 파일은 올릴 수 없습니다.";
  return null;
}

/**
 * 아바타 URL. 변경 시각을 쿼리로 붙여 브라우저 캐시를 무효화한다.
 * 아바타가 없으면 null(이니셜 표시).
 */
export function avatarUrl(userId: string, updatedAt: string | null): string | null {
  if (!updatedAt) return null;
  return `/api/users/${encodeURIComponent(userId)}/avatar?v=${encodeURIComponent(updatedAt)}`;
}

/** 아바타가 없을 때 쓸 첫 글자(대문자). */
export function avatarInitial(name: string | null | undefined): string {
  const trimmed = (name ?? "").replace(/^@/, "").trim();
  if (!trimmed) return "?";
  return trimmed.slice(0, 1).toUpperCase();
}

/**
 * 이미지를 정사각 128px JPEG 로 줄여 base64 로 돌려준다.
 * 서버 본문 한도(기본 160KB) 안에 넉넉히 들어간다.
 */
export async function fileToAvatarPayload(file: File): Promise<AvatarPayload> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side === 0) throw new Error("empty image");
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_OUTPUT_SIZE;
    canvas.height = AVATAR_OUTPUT_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_OUTPUT_SIZE,
      AVATAR_OUTPUT_SIZE,
    );
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const comma = dataUrl.indexOf(",");
    return { mime: "image/jpeg", data: dataUrl.slice(comma + 1) };
  } finally {
    bitmap.close?.();
  }
}
