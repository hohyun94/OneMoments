import { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { AppError, asyncHandler } from "../http/errors.js";
import { createRateLimiter } from "../http/middleware.js";
import {
  signupRequestBodySchema,
  signupRequestStatusQuerySchema,
} from "../http/validation.js";
import { createSignupRequest, getSignupRequestStatus } from "../services/signupRequests.js";

/**
 * 가입 신청(관리자 승인형) — **공개** 경로.
 *
 * - 신청: 아이디와 한 줄 소개만 받는다(비밀번호·기기 키는 승인 후 가입 단계에서 받는다).
 * - 상태: 신청 시 1회 발급한 토큰으로만 조회한다. 승인되면 1회용 초대 코드가 함께 내려간다.
 */
export function createSignupRequestsRouter(db: Database, config: Config): Router {
  const router = Router();

  const limiter = createRateLimiter({
    windowMs: config.authRateLimitWindowMs,
    max: config.authRateLimitMax,
    key: (req) => req.ip ?? "unknown",
    message: "Too many signup requests",
  });

  router.post(
    "/",
    limiter,
    asyncHandler(async (req, res) => {
      if (!config.signupRequestEnabled || config.signupMode === "closed") {
        throw AppError.forbidden("가입 신청을 받지 않습니다.");
      }
      const body = signupRequestBodySchema.parse(req.body);
      const { token, request } = await createSignupRequest(db, {
        username: body.username,
        note: body.note,
      });
      res.status(201).json({
        token,
        status: request.status,
        username: request.username,
        requestedAt: request.createdAt.toISOString(),
      });
    }),
  );

  router.get(
    "/status",
    limiter,
    asyncHandler(async (req, res) => {
      const { token } = signupRequestStatusQuerySchema.parse(req.query);
      res.json(await getSignupRequestStatus(db, token));
    }),
  );

  return router;
}
