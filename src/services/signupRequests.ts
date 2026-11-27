import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  signupInvites,
  signupRequests,
  users,
  type SignupInviteRow,
  type SignupRequestRow,
} from "../db/schema.js";
import { AppError } from "../http/errors.js";
import { recordAdminAudit } from "./admin.js";
import { createSignupInvite } from "./signupInvites.js";

/**
 * 가입 신청(관리자 승인형 가입).
 *
 * - 신청 단계에서는 **비밀번호·기기 키를 받지 않는다**(E2E 불변식: 승인 전 비밀 정보 미보관).
 * - 관리자가 승인하면 **1회용 초대 코드**를 발급하고, 신청자는 그 코드로 가입을 완료한다.
 * - 신청자는 신청 시 1회 발급한 토큰으로만 상태를 조회한다(DB에는 SHA-256 해시만 저장).
 */

export const SIGNUP_REQUEST_TOKEN_BYTES = 32;
/** 승인 시 발급하는 1회용 코드의 유효 기간(일). */
export const APPROVED_INVITE_TTL_DAYS = 7;

export type SignupRequestStatus = "pending" | "approved" | "rejected";

export interface SignupRequestStatusView {
  status: SignupRequestStatus;
  username: string;
  requestedAt: string;
  decidedAt: string | null;
  /** 승인 후 이미 가입을 마쳤는지(토큰은 1회용). */
  completed: boolean;
  /** 거절 사유(거절된 경우에만). */
  reviewNote: string | null;
}

export interface SignupRequestListItem {
  id: string;
  username: string;
  note: string | null;
  status: SignupRequestStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  reviewNote: string | null;
  /** 승인 후 가입을 마친 시각(없으면 미완료). */
  completedAt: string | null;
}

/** 상태 조회 토큰의 해시. 원문은 저장하지 않는다. */
export function hashSignupRequestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** 승인된 1회용 코드가 아직 쓸 수 있는지. */
function isInviteUsable(invite: SignupInviteRow | null): invite is SignupInviteRow {
  if (!invite) return false;
  if (invite.revokedAt !== null) return false;
  if (invite.expiresAt !== null && invite.expiresAt.getTime() <= Date.now()) return false;
  return invite.usedCount < invite.maxUses;
}

/**
 * 가입 신청을 만든다.
 *
 * 같은 아이디로 **이미 계정이 있거나 대기 중인 신청**이 있으면 409 로 막는다(중복 승인·혼선 방지).
 */
export async function createSignupRequest(
  db: Database,
  input: { username: string; note: string },
): Promise<{ token: string; request: SignupRequestRow }> {
  const username = input.username.trim();
  const normalized = normalizeUsername(username);

  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = ${normalized}`)
    .limit(1);
  if (existingUser) {
    throw AppError.conflict("USERNAME_TAKEN", "Username is already taken");
  }

  const [pending] = await db
    .select({ id: signupRequests.id })
    .from(signupRequests)
    .where(
      and(
        eq(signupRequests.status, "pending"),
        sql`lower(${signupRequests.username}) = ${normalized}`,
      ),
    )
    .limit(1);
  if (pending) {
    throw AppError.conflict(
      "SIGNUP_REQUEST_PENDING",
      "A signup request for this username is already waiting for review",
    );
  }

  const token = randomBytes(SIGNUP_REQUEST_TOKEN_BYTES).toString("base64url");
  const note = input.note.trim();
  const [row] = await db
    .insert(signupRequests)
    .values({
      username,
      note,
      tokenHash: hashSignupRequestToken(token),
    })
    .returning();
  if (!row) {
    throw new Error("Failed to create the signup request");
  }
  return { token, request: row };
}

/** 신청자가 토큰으로 자기 신청 상태를 본다. */
export async function getSignupRequestStatus(
  db: Database,
  token: string,
): Promise<SignupRequestStatusView> {
  const [row] = await db
    .select({ request: signupRequests, invite: signupInvites })
    .from(signupRequests)
    .leftJoin(signupInvites, eq(signupInvites.id, signupRequests.inviteId))
    .where(eq(signupRequests.tokenHash, hashSignupRequestToken(token)))
    .limit(1);
  if (!row) {
    throw AppError.notFound("SIGNUP_REQUEST_NOT_FOUND", "Signup request not found");
  }

  const { request, invite } = row;
  const status = request.status as SignupRequestStatus;
  const usable = isInviteUsable(invite);
  return {
    status,
    username: request.username,
    requestedAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    completed: request.completedAt !== null,
    reviewNote: status === "rejected" ? request.reviewNote : null,
  };
}

/** 관리자 목록(최신순). */
export async function listSignupRequests(
  db: Database,
  options: { status?: SignupRequestStatus; limit?: number } = {},
): Promise<SignupRequestListItem[]> {
  const base = db
    .select({ request: signupRequests, invite: signupInvites })
    .from(signupRequests)
    .leftJoin(signupInvites, eq(signupInvites.id, signupRequests.inviteId))
    .orderBy(desc(signupRequests.createdAt))
    .limit(options.limit ?? 100);

  const rows = options.status
    ? await base.where(eq(signupRequests.status, options.status))
    : await base;

  return rows.map(({ request, invite }) => ({
    id: request.id,
    username: request.username,
    note: request.note,
    status: request.status as SignupRequestStatus,
    requestedAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    decidedByUserId: request.decidedByUserId,
    reviewNote: request.reviewNote,
    completedAt: request.completedAt?.toISOString() ?? null,
  }));
}

/**
 * 승인 — 대기 상태에서만 가능하며, 같은 트랜잭션에서 1회용 초대 코드를 발급한다.
 * (승인과 코드 발급이 따로 놀면 "승인됐는데 코드가 없는" 상태가 생긴다.)
 */
export async function approveSignupRequest(
  db: Database,
  input: { requestId: string; adminUserId: string; adminUsername: string },
): Promise<SignupRequestRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(signupRequests)
      .where(eq(signupRequests.id, input.requestId))
      .limit(1);
    if (!row) {
      throw AppError.notFound("SIGNUP_REQUEST_NOT_FOUND", "Signup request not found");
    }
    if (row.status !== "pending") {
      throw AppError.conflict("SIGNUP_REQUEST_DECIDED", "This request was already decided");
    }

    const [existingUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = ${normalizeUsername(row.username)}`)
      .limit(1);
    if (existingUser) {
      throw AppError.conflict("USERNAME_TAKEN", "Username is already taken");
    }

    const [updated] = await tx
      .update(signupRequests)
      .set({
        status: "approved",
        decidedByUserId: input.adminUserId,
        decidedAt: sql`now()`,
        reviewNote: null,
      })
      .where(and(eq(signupRequests.id, row.id), eq(signupRequests.status, "pending")))
      .returning();
    if (!updated) {
      throw AppError.conflict("SIGNUP_REQUEST_DECIDED", "This request was already decided");
    }

    await recordAdminAudit(tx, {
      adminUserId: input.adminUserId,
      adminUsername: input.adminUsername,
      action: "signup.request.approved",
      targetUsername: row.username,
      detail: { requestId: row.id },
    });
    return updated;
  });
}

/** 거절 — 대기 상태에서만 가능하며, 사유(선택)를 남긴다. */
export async function rejectSignupRequest(
  db: Database,
  input: { requestId: string; adminUserId: string; adminUsername: string; note?: string },
): Promise<SignupRequestRow> {
  return db.transaction(async (tx) => {
    const note = input.note?.trim() ?? "";
    const [row] = await tx
      .update(signupRequests)
      .set({
        status: "rejected",
        decidedByUserId: input.adminUserId,
        decidedAt: sql`now()`,
        reviewNote: note.length > 0 ? note : null,
      })
      .where(and(eq(signupRequests.id, input.requestId), eq(signupRequests.status, "pending")))
      .returning();

    if (!row) {
      throw AppError.conflict("SIGNUP_REQUEST_DECIDED", "This request was already decided");
    }
    await recordAdminAudit(tx, {
      adminUserId: input.adminUserId,
      adminUsername: input.adminUsername,
      action: "signup.request.rejected",
      targetUsername: row.username,
      detail: { requestId: row.id },
    });
    return row;
  });
}


/**
 * 승인된 신청 토큰을 **가입 트랜잭션 안에서** 1회용으로 소모한다.
 *
 * 승인 상태가 아니거나, 이미 가입에 쓴 토큰이거나, 아이디가 신청과 다르면 거부한다.
 * 이 함수가 성공하면 계정 생성이 같은 트랜잭션에서 이어진다(실패 시 completedAt 도 롤백).
 */
export async function consumeApprovedSignupRequest(
  db: Database,
  input: { token: string; username: string },
): Promise<void> {
  const normalized = normalizeUsername(input.username);
  const [row] = await db
    .update(signupRequests)
    .set({ completedAt: sql`now()` })
    .where(
      and(
        eq(signupRequests.tokenHash, hashSignupRequestToken(input.token)),
        eq(signupRequests.status, "approved"),
        isNull(signupRequests.completedAt),
        sql`lower(${signupRequests.username}) = ${normalized}`,
      ),
    )
    .returning({ id: signupRequests.id });
  if (!row) {
    throw AppError.forbidden("승인된 가입 신청을 찾을 수 없습니다. 관리자에게 다시 확인해 주세요.");
  }
}