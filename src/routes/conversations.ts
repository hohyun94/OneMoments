import { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { asyncHandler } from "../http/errors.js";
import { createRateLimiter, getAuth, requireCsrf, requireSession } from "../http/middleware.js";
import {
  conversationIdParamsSchema,
  createConversationBodySchema,
  listMessagesQuerySchema,
  sendMessageBodySchema,
} from "../http/validation.js";
import type { MessageBus } from "../realtime/bus.js";
import {
  findOrCreateDirectConversation,
  getConversationSummary,
  hideConversation,
  listActiveDeviceKeys,
  listConversations,
  requireParticipant,
} from "../services/conversations.js";
import { sendEncryptedMessage } from "../services/messageFlow.js";
import { listMessages } from "../services/messages.js";

export interface ConversationsRouterOptions {
  db: Database;
  config: Config;
  bus: MessageBus;
}

export function createConversationsRouter(options: ConversationsRouterOptions): Router {
  const { db, config, bus } = options;
  const router = Router();
  const session = requireSession(db);
  const csrf = requireCsrf(config);
  const messageLimiter = createRateLimiter({
    windowMs: config.messageRateLimitWindowMs,
    max: config.messageRateLimitMax,
    key: (req) => req.auth?.userId ?? req.ip ?? "unknown",
    message: "Message rate limit exceeded",
  });

  router.post(
    "/",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = createConversationBodySchema.parse(req.body);
      const { conversation, created } = await findOrCreateDirectConversation(db, {
        creatorUserId: auth.userId,
        peerUserId: body.peerUserId,
      });
      const context = await requireParticipant(db, {
        conversationId: conversation.id,
        userId: auth.userId,
      });
      res.status(created ? 201 : 200).json({
        conversation: await getConversationSummary(db, context),
        created,
      });
    }),
  );

  router.get(
    "/",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      res.json({ conversations: await listConversations(db, auth.userId) });
    }),
  );

  router.get(
    "/:conversationId/devices",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      await requireParticipant(db, { conversationId, userId: auth.userId });
      const devices = await listActiveDeviceKeys(db, conversationId);
      res.json({ devices });
    }),
  );

  router.delete(
    "/:conversationId",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      await requireParticipant(db, { conversationId, userId: auth.userId });
      await hideConversation(db, { conversationId, userId: auth.userId });
      res.status(204).end();
    }),
  );

  router.get(
    "/:conversationId/messages",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      await requireParticipant(db, { conversationId, userId: auth.userId });
      const query = listMessagesQuerySchema.parse(req.query);
      const page = await listMessages(db, {
        conversationId,
        viewerDeviceId: auth.deviceId,
        before: query.before,
        limit: query.limit,
      });
      res.json(page);
    }),
  );

  router.post(
    "/:conversationId/messages",
    session,
    csrf,
    messageLimiter,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      const body = sendMessageBodySchema.parse(req.body);

      const result = await sendEncryptedMessage(db, config, {
        conversationId,
        senderUserId: auth.userId,
        senderDeviceId: auth.deviceId,
        payload: body,
      });
      // 멱등 재전송은 새 이벤트가 아니므로 다시 브로드캐스트하지 않는다.
      if (result.created) bus.publish(result.event);

      res.status(result.created ? 201 : 200).json({
        message: result.message,
        created: result.created,
      });
    }),
  );

  return router;
}
