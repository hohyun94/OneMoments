import { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { AppError, asyncHandler } from "../http/errors.js";
import { createRateLimiter, getAuth, requireSession } from "../http/middleware.js";
import { fetchLinkPreview } from "../services/linkPreview.js";

/**
 * 링크 미리보기 메타데이터(Open Graph) 조회.
 *
 * 서버가 외부 페이지를 대신 가져오므로 SSRF 방어(사설 IP·스킴·리다이렉트·크기·타임아웃)를 적용하고,
 * 결과는 **저장하지 않는다**(클라이언트가 메시지 암호문 안에 넣어 전송).
 */
export function createLinkPreviewRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);
  const limiter = createRateLimiter({
    windowMs: 60_000,
    max: 20,
    key: (req) => req.auth?.userId ?? req.ip ?? "unknown",
    message: "Too many link previews",
  });

  router.get(
    "/",
    session,
    limiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      if (!config.linkPreviewEnabled) {
        throw AppError.forbidden("Link previews are disabled");
      }
      const raw = typeof req.query.url === "string" ? req.query.url : "";
      const preview = raw.length > 0 && raw.length <= 2048 ? await fetchLinkPreview({ url: raw }) : null;
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ preview, userId: auth.userId });
    }),
  );

  return router;
}
