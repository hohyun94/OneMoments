import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { users } from "../db/schema.js";
import { AppError } from "../http/errors.js";

/**
 * 아바타 원본 바이트 상한.
 *
 * 전역 JSON 본문 한도(`MAX_CIPHERTEXT_BYTES` 기반, 기본 160KB) 안에 들어오도록 작게 유지한다.
 * 클라이언트는 128px 로 줄여 올리므로 실제 크기는 10~20KB 수준이다.
 */
export const AVATAR_MAX_BYTES = 64 * 1024;

export interface StoredAvatar {
  mime: string;
  data: Buffer;
  updatedAt: Date | null;
}

/**
 * 공개 프로필 아바타를 저장한다.
 *
 * 상태 메시지와 같은 **공개 메타데이터**라 암호화하지 않는다(서버가 이미지를 보관한다).
 * 크기·MIME 은 라우터의 zod 스키마와 여기서 다시 확인한다.
 */
export async function setUserAvatar(
  db: Database,
  input: { userId: string; mime: string; dataBase64: string },
): Promise<{ avatarUpdatedAt: Date }> {
  const data = Buffer.from(input.dataBase64, "base64");
  if (data.length === 0) throw AppError.badRequest("AVATAR_EMPTY", "Avatar is empty");
  if (data.length > AVATAR_MAX_BYTES)
    throw AppError.badRequest("AVATAR_TOO_LARGE", "Avatar is too large");

  const [row] = await db
    .update(users)
    .set({
      avatarMime: input.mime,
      avatarData: data.toString("base64"),
      avatarUpdatedAt: sql`now()`,
    })
    .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
    .returning({ avatarUpdatedAt: users.avatarUpdatedAt });
  if (!row?.avatarUpdatedAt) throw AppError.unauthorized("Unknown account");
  return { avatarUpdatedAt: row.avatarUpdatedAt };
}

/** 아바타를 지운다(없어도 성공). */
export async function clearUserAvatar(db: Database, input: { userId: string }): Promise<void> {
  await db
    .update(users)
    .set({ avatarMime: null, avatarData: null, avatarUpdatedAt: null })
    .where(and(eq(users.id, input.userId), isNull(users.deletedAt)));
}

/** 사용자의 아바타 바이트를 읽는다. 없거나 삭제된 계정이면 null. */
export async function findUserAvatar(
  db: Database,
  input: { userId: string },
): Promise<StoredAvatar | null> {
  const [row] = await db
    .select({
      mime: users.avatarMime,
      data: users.avatarData,
      updatedAt: users.avatarUpdatedAt,
    })
    .from(users)
    .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
    .limit(1);
  if (!row?.mime || !row.data) return null;
  return {
    mime: row.mime,
    data: Buffer.from(row.data, "base64"),
    updatedAt: row.updatedAt,
  };
}
