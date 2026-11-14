import { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { AppError, asyncHandler } from "../http/errors.js";
import { getAuth, requireCsrf, requireSession } from "../http/middleware.js";
import {
  pushSubscriptionBodySchema,
  pushUnsubscribeBodySchema,
} from "../http/validation.js";
import { isAllowedPushEndpoint, normalizePushKeys } from "../push/webPush.js";
import {
  removePushSubscription,
  upsertPushSubscription,
} from "../services/push.js";

export function createPushRouter(db: Database, config: Config): Router {
  const router = Router();
  const session = requireSession(db);
  const csrf = requireCsrf(config);

  router.get(
    "/public-key",
    session,
    asyncHandler(async (_req, res) => {
      if (!config.vapidPublicKey) {
        throw new AppError(503, "PUSH_DISABLED", "Push notifications are not configured");
      }
      res.json({ publicKey: config.vapidPublicKey });
    }),
  );

  router.post(
    "/subscriptions",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = pushSubscriptionBodySchema.parse(req.body);
      const endpoint = new URL(body.endpoint);
      if (!isAllowedPushEndpoint(endpoint, config.nodeEnv !== "production")) {
        throw AppError.badRequest(
          "INVALID_PUSH_ENDPOINT",
          "Push endpoint must be a supported push service URL",
        );
      }
      if (!config.vapidPublicKey) {
        throw new AppError(503, "PUSH_DISABLED", "Push notifications are not configured");
      }

      let keys;
      try {
        keys = normalizePushKeys(body.keys.p256dh, body.keys.auth);
      } catch {
        throw AppError.badRequest(
          "INVALID_PUSH_KEYS",
          "Push subscription keys are invalid",
        );
      }

      const subscription = await upsertPushSubscription(db, {
        userId: auth.userId,
        deviceId: auth.deviceId,
        endpoint: body.endpoint,
        ...keys,
      });
      res.status(201).json({ subscription: { id: subscription.id } });
    }),
  );

  router.delete(
    "/subscriptions",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = pushUnsubscribeBodySchema.parse(req.body);
      await removePushSubscription(db, {
        userId: auth.userId,
        deviceId: auth.deviceId,
        endpoint: body.endpoint,
      });
      res.status(204).end();
    }),
  );

  return router;
}
