import express, { Router } from "express";
import { and, eq } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { messages } from "../db/schema.js";
import { AppError, asyncHandler } from "../http/errors.js";
import { createRateLimiter, getAuth, requireCsrf, requireSession } from "../http/middleware.js";
import {
  addConversationMembersBodySchema,
  conversationIdParamsSchema,
  createConversationBodySchema,
  createInviteBodySchema,
  listMessagesQuerySchema,
  markReadBodySchema,
  messageIdParamsSchema,
  sendMessageBodySchema,
  updateAutoDeleteBodySchema,
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
  listConversationReadReceipts,
  listParticipantUserIds,
  markConversationRead,
  leaveGroup,
  renameGroup,
  requireParticipant,
  setConversationAutoDelete,
  setConversationMuted,
} from "../services/conversations.js";
import { sendEncryptedMessage } from "../services/messageFlow.js";
import { listMessages } from "../services/messages.js";
import {
  createAttachment,
  createAttachmentStorage,
} from "../services/attachments.js";
import { cleanupAutoDeletedMessages, deleteMessagesAndArtifacts } from "../services/autoDelete.js";
import { createConversationInvite } from "../services/invites.js";

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
  const attachmentStorage = createAttachmentStorage(config);

  // 자동 삭제는 별도 크론이 없어도 동작하도록 조회 시 제한적으로 실행한다.
  const LAZY_CLEANUP_INTERVAL_MS = 60_000;
  const GLOBAL_CLEANUP_INTERVAL_MS = 5 * 60_000;
  const lastCleanupByConversation = new Map<string, number>();
  let lastGlobalCleanupAt = 0;

  async function runCleanup(conversationId?: string): Promise<void> {
    try {
      await cleanupAutoDeletedMessages(db, attachmentStorage, {
        ...(conversationId ? { conversationId } : {}),
        limit: 200,
      });
    } catch (error) {
      // 메시지 내용·키는 남기지 않는다.
      console.error(
        JSON.stringify({
          level: "error",
          event: "auto_delete_cleanup_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function maybeCleanupConversation(conversationId: string): Promise<void> {
    const now = Date.now();
    const last = lastCleanupByConversation.get(conversationId) ?? 0;
    if (now - last < LAZY_CLEANUP_INTERVAL_MS) return;
    if (lastCleanupByConversation.size > 1_000) lastCleanupByConversation.clear();
    lastCleanupByConversation.set(conversationId, now);
    await runCleanup(conversationId);
  }

  async function maybeGlobalCleanup(): Promise<void> {
    const now = Date.now();
    if (now - lastGlobalCleanupAt < GLOBAL_CLEANUP_INTERVAL_MS) return;
    lastGlobalCleanupAt = now;
    await runCleanup();
  }

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
      await maybeGlobalCleanup();
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

  router.get(
    "/:conversationId/reads",
    session,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      await requireParticipant(db, { conversationId, userId: auth.userId });
      const reads = await listConversationReadReceipts(db, conversationId);
      res.json({
        reads: reads.map((read) => ({
          userId: read.userId,
          lastReadMessageId: read.lastReadMessageId,
          readAt: read.readAt.toISOString(),
          updatedAt: read.updatedAt.toISOString(),
        })),
      });
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

  router.put(
    "/:conversationId/auto-delete",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      const body = updateAutoDeleteBodySchema.parse(req.body);
      const conversation = await setConversationAutoDelete(db, {
        conversationId,
        userId: auth.userId,
        seconds: body.seconds,
      });
      res.json({ conversation });
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

      const clientMessageId = req.header("x-attachment-client-message-id");
      if (
        clientMessageId !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          clientMessageId,
        )
      ) {
        throw AppError.badRequest(
          "INVALID_ATTACHMENT",
          "x-attachment-client-message-id must be a UUID",
        );
      }
      const attachment = await createAttachment(db, {
        conversationId,
        uploaderUserId: auth.userId,
        messageClientId: clientMessageId ?? null,
        storage: attachmentStorage,
        data: req.body,
      });
      res.status(201).json({ attachment: { id: attachment.id, size: attachment.size } });
    }),
  );

  router.post(
    "/:conversationId/invites",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId } = conversationIdParamsSchema.parse(req.params);
      const body = createInviteBodySchema.parse(req.body ?? {});
      const invite = await createConversationInvite(db, {
        conversationId,
        userId: auth.userId,
        expiresInSeconds: body.expiresInSeconds,
        maxUses: body.maxUses,
      });
      res.status(201).json({ invite });
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
      await maybeCleanupConversation(conversationId);
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

  router.delete(
    "/:conversationId/messages/:messageId",
    session,
    csrf,
    asyncHandler(async (req, res) => {
      const auth = getAuth(req);
      const { conversationId, messageId } = messageIdParamsSchema.parse(req.params);
      await requireParticipant(db, { conversationId, userId: auth.userId });

      const [message] = await db
        .select({ senderUserId: messages.senderUserId })
        .from(messages)
        .where(
          and(
            eq(messages.id, messageId),
            eq(messages.conversationId, conversationId),
          ),
        )
        .limit(1);
      if (!message) {
        throw AppError.notFound("MESSAGE_NOT_FOUND", "Message not found");
      }
      if (message.senderUserId !== auth.userId) {
        throw AppError.forbidden("Only the sender can delete this message");
      }

      const result = await deleteMessagesAndArtifacts(db, attachmentStorage, {
        conversationId,
        messageIds: [messageId],
      });
      if (result.deletedMessageIds.length > 0) {
        const participantUserIds = await listParticipantUserIds(db, conversationId);
        bus.publish({
          type: "message.deleted",
          conversationId,
          messageIds: result.deletedMessageIds,
          participantUserIds,
        });
      }
      res.json({ deletedMessageIds: result.deletedMessageIds });
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
        kind: body.kind,
        targetMessageId: body.targetMessageId,
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
