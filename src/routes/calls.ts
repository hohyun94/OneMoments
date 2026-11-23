import { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { asyncHandler } from "../http/errors.js";
import { getAuth, requireSession } from "../http/middleware.js";
import { buildIceServers } from "../services/turn.js";

/**
 * 1:1 음성 통화 부트스트랩.
 *
 * 서버는 시그널링(WS)만 중계하고 미디어는 저장·복호화하지 않는다.
 * 여기서는 클라이언트가 `RTCPeerConnection` 을 만들 때 쓸 ICE 서버와 정책만 내려준다.
 * TURN 자격증명은 사용자·만료시각에 묶인 단기 값이라 로그/캐시에 남겨도 재사용 기간이 짧다.
 */
export function createCallsRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);

  router.get(
    "/config",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        enabled: config.calls.enabled,
        iceServers: config.calls.enabled ? buildIceServers(config, auth.userId) : [],
        ringTimeoutSeconds: config.calls.ringTimeoutSeconds,
        /** 1:1 음성만 지원한다(v1). */
        media: "audio",
      });
    }),
  );

  return router;
}
