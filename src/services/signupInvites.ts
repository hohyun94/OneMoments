import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import type { Database } from "../db/client.js";
import { signupInvites, type SignupInviteRow } from "../db/schema.js";
import { AppError } from "../http/errors.js";

/**
 * 가입 초대 코드.
 *
 * - 코드는 헷갈리는 문자(0/O/1/I)를 뺀 12자로 생성하고 대문자로 정규화한다.
 * - 사용 횟수·만료·폐기로 통제하며, 소모는 **가입 트랜잭션 안에서 원자적 UPDATE** 로 처리한다.
 */

export const SIGNUP_INVITE_CODE_LENGTH = 12;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 입력 코드를 정규화한다(공백·하이픈 제거, 대문자). */
export function normalizeInviteCode(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function generateInviteCode(): string {
  const bytes = randomBytes(SIGNUP_INVITE_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

/** 초대 코드를 발급한다(충돌 시 재시도). */
export async function createSignupInvite(
  db: Database,
  input: { createdByUserId: string | null; maxUses: number; expiresAt: Date | null },
): Promise<SignupInviteRow> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [row] = await db
      .insert(signupInvites)
      .values({
        code: generateInviteCode(),
        createdByUserId: input.createdByUserId,
        maxUses: input.maxUses,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing({ target: signupInvites.code })
      .returning();
    if (row) return row;
  }
  throw new Error("Failed to generate a unique signup invite code");
}

/** 최근 발급 목록(최신순). */
export async function listSignupInvites(db: Database, limit = 50): Promise<SignupInviteRow[]> {
  return db.select().from(signupInvites).orderBy(desc(signupInvites.createdAt)).limit(limit);
}

/** 초대 코드를 폐기한다(이미 폐기된 코드는 404). */
export async function revokeSignupInvite(
  db: Database,
  input: { id: string },
): Promise<{ id: string }> {
  const [row] = await db
    .update(signupInvites)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(signupInvites.id, input.id), isNull(signupInvites.revokedAt)))
    .returning({ id: signupInvites.id });
  if (!row) throw AppError.notFound("INVITE_NOT_FOUND", "Invite not found");
  return row;
}

/**
 * 가입 트랜잭션 안에서 코드를 소모한다.
 *
 * 유효하지 않으면(없음·폐기·만료·소진) `INVITE_INVALID` 로 실패하며, 트랜잭션이 롤백되면 사용 횟수도 되돌아간다.
 */
export async function consumeSignupInvite(db: Database, code: string): Promise<void> {
  const normalized = normalizeInviteCode(code);
  if (normalized.length === 0) {
    throw AppError.badRequest("INVITE_REQUIRED", "초대 코드가 필요합니다.");
  }
  const [row] = await db
    .update(signupInvites)
    .set({ usedCount: sql`${signupInvites.usedCount} + 1` })
    .where(
      and(
        eq(signupInvites.code, normalized),
        isNull(signupInvites.revokedAt),
        sql`(${signupInvites.expiresAt} is null or ${signupInvites.expiresAt} > now())`,
        sql`${signupInvites.usedCount} < ${signupInvites.maxUses}`,
      ),
    )
    .returning({ id: signupInvites.id });
  if (!row) {
    throw AppError.forbidden("초대 코드가 유효하지 않습니다.");
  }
}
