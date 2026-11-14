import { z } from "zod";

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(32, "Username must be at most 32 characters")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
    "Username may contain letters, digits, dot, dash, underscore",
  )
  .transform((value) => value.toLowerCase());

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(200, "Password must be at most 200 characters");

export const deviceNameSchema = z
  .string()
  .trim()
  .min(1, "Device name is required")
  .max(64, "Device name must be at most 64 characters");

export const publicKeySchema = z.string().min(1, "Public key is required").max(256);

export const deviceKeysSchema = z.object({
  name: deviceNameSchema,
  identityPublicKey: publicKeySchema,
  signingPublicKey: publicKeySchema,
});

export const registerBodySchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  device: deviceKeysSchema,
});

export const loginBodySchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(200),
  deviceId: z.string().uuid().optional(),
  device: deviceKeysSchema.optional(),
});

export const registerDeviceBodySchema = deviceKeysSchema;

export const createConversationBodySchema = z.object({
  peerUserId: z.string().uuid(),
});

export const sendMessageBodySchema = z.object({
  clientMessageId: z
    .string()
    .min(1, "clientMessageId is required")
    .max(64, "clientMessageId must be at most 64 characters")
    .regex(/^[A-Za-z0-9_-]+$/, "clientMessageId may contain letters, digits, dash, underscore"),
  ciphertext: z.string().min(1, "ciphertext is required"),
  nonce: z.string().min(1, "nonce is required"),
  signature: z.string().min(1, "signature is required"),
  keys: z
    .array(
      z.object({
        deviceId: z.string().uuid(),
        ephemeralPublicKey: z.string().min(1),
        wrappedKey: z.string().min(1),
        wrapNonce: z.string().min(1),
        version: z.number().int().optional(),
      }),
    )
    .min(1)
    .max(200),
});

export const listMessagesQuerySchema = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const searchUsersQuerySchema = z.object({
  username: z.string().trim().min(1).max(32),
});

export const conversationIdParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;
