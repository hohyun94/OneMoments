import { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { asyncHandler } from "../http/errors.js";
import { getAuth, requireCsrf, requireSession } from "../http/middleware.js";
import { inviteTokenParamsSchema } from "../http/validation.js";
import {
  getConversationSummary,
  requireParticipant,
} from "../services/conversations.js";
import { acceptConversationInvite } from "../services/invites.js";

export function createInvitesRouter(options: { db: Database; config: Config }): Router {
  const { db, config } = options;
  const router = Router();
  const session = requireSession(db);
  const csrf = requireCsrf(config);

  router.post(
    "/:token/accept",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { token } = inviteTokenParamsSchema.parse(req.params);
      const { conversation } = await acceptConversationInvite(db, {
        token,
        userId: auth.userId,
      });
      const context = await requireParticipant(db, {
        conversationId: conversation.id,
        userId: auth.userId,
      });
      res.json({ conversation: await getConversationSummary(db, context) });
    }),
  );

  return router;
}
