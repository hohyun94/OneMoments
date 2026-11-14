import express, { Router } from "express";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { AppError, asyncHandler } from "../http/errors.js";
import { createRateLimiter, getAuth, requireCsrf, requireSession } from "../http/middleware.js";
import {
  addConversationMembersBodySchema,
  conversationIdParamsSchema,
  createConversationBodySchema,
  listMessagesQuerySchema,
  markReadBodySchema,
  sendMessageBodySchema,
  updateConversationNotificationBodySchema,
  updateGroupBodySchema,
} from "../http/validation.js";
import type { MessageBus } from "../realtime/bus.js";
import {
  addGroupMembers,
  createGroupConversation,
  findOrCreateDirectConversation,
  getConversationSummary,
  hideConversation,
  listActiveDeviceKeys,
  listConversations,
  markConversationRead,
  leaveGroup,
  renameGroup,
  requireParticipant,
  setConversationMuted,
} from "../services/conversations.js";
import { sendEncryptedMessage } from "../services/messageFlow.js";
import { listMessages } from "../services/messages.js";
import { createAttachment } from "../services/attachments.js";

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
  const attachmentLimiter = createRateLimiter({
    windowMs: config.messageRateLimitWindowMs,
    max: Math.max(4, Math.floor(config.messageRateLimitMax / 4)),
    key: (req) => req.auth?.userId ?? req.ip ?? "unknown",
    message: "Attachment rate limit exceeded",
  });

  router.post(
    "/",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const body = createConversationBodySchema.parse(req.body);
      const result =
        "peerUserId" in body
          ? await findOrCreateDirectConversation(db, {
              creatorUserId: auth.userId,
              peerUserId: body.peerUserId,
            })
          : {
              conversation: await createGroupConversation(db, {
                creatorUserId: auth.userId,
                name: body.name,
                memberUserIds: body.memberUserIds,
              }),
              created: true,
            };
      const context = await requireParticipant(db, {
        conversationId: result.conversation.id,
        userId: auth.userId,
      });
      res.status(result.created ? 201 : 200).json({
        conversation: await getConversationSummary(db, context),
        created: result.created,
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

  router.put(
    "/:conversationId/group",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      const body = updateGroupBodySchema.parse(req.body);
      await renameGroup(db, {
        conversationId,
        userId: auth.userId,
        name: body.name,
      });
      const context = await requireParticipant(db, { conversationId, userId: auth.userId });
      res.json({ conversation: await getConversationSummary(db, context) });
    }),
  );

  router.delete(
    "/:conversationId/members/me",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      await leaveGroup(db, { conversationId, userId: auth.userId });
      res.status(204).end();
    }),
  );

  router.put(
    "/:conversationId/read",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      const body = markReadBodySchema.parse(req.body);
      await requireParticipant(db, { conversationId, userId: auth.userId });
      await markConversationRead(db, {
        conversationId,
        userId: auth.userId,
        messageId: body.messageId,
      });
      res.json({ unreadCount: 0 });
    }),
  );

  router.put(
    "/:conversationId/notification",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      const body = updateConversationNotificationBodySchema.parse(req.body);
      await requireParticipant(db, { conversationId, userId: auth.userId });
      const muted = await setConversationMuted(db, {
        conversationId,
        userId: auth.userId,
        muted: body.muted,
      });
      res.json({ muted });
    }),
  );

  router.get(
    "/:conversationId",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      const context = await requireParticipant(db, { conversationId, userId: auth.userId });
      res.json({ conversation: await getConversationSummary(db, context) });
    }),
  );

  router.post(
    "/:conversationId/members",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      const body = addConversationMembersBodySchema.parse(req.body);
      const { added } = await addGroupMembers(db, {
        conversationId,
        requesterUserId: auth.userId,
        userIds: body.userIds,
      });
      const context = await requireParticipant(db, { conversationId, userId: auth.userId });
      res.json({ conversation: await getConversationSummary(db, context), added });
    }),
  );

  router.post(
    "/:conversationId/attachments",
    session,
    csrf,
    attachmentLimiter,
    express.raw({ type: "application/octet-stream", limit: config.attachmentMaxBytes }),
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      if (!req.is("application/octet-stream")) {
        throw new AppError(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "Attachment must be sent as application/octet-stream",
        );
      }
      await requireParticipant(db, { conversationId, userId: auth.userId });
      if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
        throw AppError.badRequest("EMPTY_ATTACHMENT", "Attachment body is empty");
      }
      if (req.body.byteLength > config.attachmentMaxBytes) {
        throw AppError.payloadTooLarge("Attachment is too large");
      }

      const attachment = await createAttachment(db, {
        conversationId,
        uploaderUserId: auth.userId,
        directory: config.attachmentDir,
        data: req.body,
      });
      res.status(201).json({ attachment: { id: attachment.id, size: attachment.size } });
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
        viewerUserId: auth.userId,
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
