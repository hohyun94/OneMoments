import { z } from "zod";

import {
  MAX_IDLE_TIMEOUT_SECONDS,
  MIN_IDLE_TIMEOUT_SECONDS,
} from "../auth/idleTimeout.js";
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

/** 클라이언트가 신고하는 플랫폼. 없으면 unknown. */
export const devicePlatformSchema = z
  .enum(["ios", "android", "mobile", "desktop", "unknown"])
  .default("unknown");

export const publicKeySchema = z.string().min(1, "Public key is required").max(256);

export const signedPreKeySchema = z.object({
  id: z.string().uuid(),
  publicKey: publicKeySchema,
  signature: publicKeySchema,
});

export const oneTimePreKeysSchema = z
  .array(
    z.object({
      id: z.string().uuid(),
      publicKey: publicKeySchema,
    }),
  )
  .max(200);

export const deviceKeysSchema = z.object({
  name: deviceNameSchema,
  platform: devicePlatformSchema,
  identityPublicKey: publicKeySchema,
  signingPublicKey: publicKeySchema,
  signedPreKey: signedPreKeySchema.optional(),
  oneTimePreKeys: oneTimePreKeysSchema.optional(),
});

export const registerBodySchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  device: deviceKeysSchema,
  /** `SIGNUP_MODE=invite` 일 때 필수(서버가 정규화해 검증). */
  inviteCode: z.string().trim().max(64).optional(),
  /** 승인된 가입 신청 토큰(있으면 초대 코드 없이 가입). */
  signupRequestToken: z.string().trim().min(20).max(200).optional(),
});

/** 관리자: 가입 초대 코드 발급. */
export const createSignupInviteBodySchema = z.object({
  maxUses: z.number().int().min(1).max(100).default(1),
  /** 만료까지 일수. null/미지정이면 무기한. */
  expiresInDays: z.number().int().min(1).max(365).nullish(),
});

export const signupInviteParamsSchema = z.object({
  inviteId: z.string().uuid(),
});

/** 가입 신청(관리자 승인형). 비밀번호·기기 키는 승인 전에 받지 않는다. */
export const signupRequestBodySchema = z.object({
  username: usernameSchema,
  /** 가입 사유(필수) — 관리자가 승인 여부를 판단하는 근거다. */
  note: z.string().trim().min(5).max(500),
});

/** 신청 상태 조회(신청 시 1회 발급한 토큰). */
export const signupRequestStatusQuerySchema = z.object({
  token: z.string().trim().min(20).max(200),
});

export const signupRequestParamsSchema = z.object({
  requestId: z.string().uuid(),
});

/** 관리자: 가입 신청 거절(사유 선택). */
export const rejectSignupRequestBodySchema = z.object({
  note: z.string().trim().max(200).optional(),
});

export const signedPreKeyBodySchema = z.object({
  signedPreKey: signedPreKeySchema,
});

export const oneTimePreKeysBodySchema = z.object({
  oneTimePreKeys: oneTimePreKeysSchema.min(1),
});

export const loginBodySchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(200),
  deviceId: z.string().uuid().optional(),
  device: deviceKeysSchema.optional(),
});

export const registerDeviceBodySchema = deviceKeysSchema;

/** Google OAuth 시작. link 는 로그인 상태에서만 허용한다. */
export const googleOAuthStartBodySchema = z.object({
  intent: z.enum(["signup", "login", "link"]),
});

export const googleOAuthCallbackQuerySchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().min(1).max(200).optional(),
});

/** 콜백이 넘긴 1회용 티켓으로 가입/로그인/연결을 마무리한다. */
export const googleOAuthCompleteBodySchema = z.object({
  ticket: z.string().uuid(),
  username: usernameSchema.optional(),
  device: deviceKeysSchema.optional(),
});

export const googleOAuthUnlinkBodySchema = z.object({
  password: z.string().min(1).max(200),
});

export const deviceIdParamsSchema = z.object({
  deviceId: z.string().uuid(),
});

/** 1~30분. "끄기"는 허용하지 않는다. */
export const idleTimeoutSecondsSchema = z
  .number()
  .int()
  .min(MIN_IDLE_TIMEOUT_SECONDS)
  .max(MAX_IDLE_TIMEOUT_SECONDS);

export const updateDeviceIdleTimeoutBodySchema = z.object({
  seconds: idleTimeoutSecondsSchema,
});

/** null 이면 세션 오버라이드를 지우고 기기 기본값을 따른다. */
export const updateSessionIdleTimeoutBodySchema = z.object({
  seconds: idleTimeoutSecondsSchema.nullable(),
});

export const groupNameSchema = z
  .string()
  .trim()
  .min(1, "Group name is required")
  .max(64, "Group name must be at most 64 characters");

export const createConversationBodySchema = z.union([
  z.object({
    kind: z.literal("direct").optional(),
    peerUserId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal("group"),
    name: groupNameSchema,
    memberUserIds: z.array(z.string().uuid()).min(1).max(19),
  }),
]);

export const updateConversationNotificationBodySchema = z.object({
  muted: z.boolean(),
});

export const updateGroupBodySchema = z.object({
  name: groupNameSchema,
});

export const addConversationMembersBodySchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(19),
});

export const messageKindSchema = z.enum(["text", "reaction", "edit"]);

export const messageKeyEnvelopeSchema = z.object({
  deviceId: z.string().uuid(),
  ephemeralPublicKey: z.string().min(1).optional(),
  ratchetPublicKey: z.string().min(1).optional(),
  previousChainLength: z.number().int().min(0).optional(),
  messageNumber: z.number().int().min(0).optional(),
  senderIdentityPublicKey: z.string().min(1).optional(),
  signedPreKeyId: z.string().uuid().optional(),
  oneTimePreKeyId: z.string().uuid().optional(),
  wrappedKey: z.string().min(1),
  wrapNonce: z.string().min(1),
  distributionCiphertext: z.string().min(1).optional(),
  distributionNonce: z.string().min(1).optional(),
  distribution: z
    .object({ ciphertext: z.string().min(1), nonce: z.string().min(1) })
    .optional(),
  version: z.number().int().optional(),
});

export const sendMessageBodySchema = z.object({
  clientMessageId: z
    .string()
    .min(1, "clientMessageId is required")
    .max(64, "clientMessageId must be at most 64 characters")
    .regex(/^[A-Za-z0-9_-]+$/, "clientMessageId may contain letters, digits, dash, underscore"),
  kind: messageKindSchema.default("text"),
  viewOnce: z.boolean().default(false),
  targetMessageId: z.string().uuid().optional(),
  ciphertext: z.string().min(1, "ciphertext is required"),
  nonce: z.string().min(1, "nonce is required"),
  signature: z.string().min(1, "signature is required"),
  keys: z.array(messageKeyEnvelopeSchema).max(200),
  senderKeyId: z.string().uuid().optional(),
  senderKeyIteration: z.number().int().min(0).optional(),
});

/** 24시간 스토리. id 는 클라이언트가 생성한다. */
export const momentBodySchema = z.object({
  id: z.string().uuid(),
  audienceUserIds: z.array(z.string().uuid()).min(1).max(50),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
  signature: z.string().min(1),
  keys: z.array(messageKeyEnvelopeSchema).max(200),
  attachmentId: z.string().uuid().optional(),
});

export type MomentBody = z.infer<typeof momentBodySchema>;

export const momentIdParamsSchema = z.object({
  momentId: z.string().uuid(),
});

export const createInviteBodySchema = z.object({
  expiresInSeconds: z.number().int().min(300).max(30 * 24 * 60 * 60).optional(),
  maxUses: z.number().int().min(1).max(20).optional(),
});

export const inviteTokenParamsSchema = z.object({
  token: z.string().min(20).max(120),
});

export const deleteAccountBodySchema = z
  .object({
    // 비밀번호 계정은 password, OAuth 전용 계정은 confirmUsername(아이디 재입력)로 확인한다.
    password: z.string().min(1).max(200).optional(),
    confirmUsername: z.string().min(1).max(32).optional(),
  })
  .refine((value) => Boolean(value.password) !== Boolean(value.confirmUsername), {
    message: "Provide exactly one of password or confirmUsername",
  });

export const backupBodySchema = z.object({
  blob: z.string().min(1, "blob is required").max(25 * 1024 * 1024),
});

export const recoveryChallengeBodySchema = z.object({
  deviceId: z.string().uuid(),
});

export const recoveryLookupBodySchema = z.object({
  username: usernameSchema,
});

export const recoverBodySchema = z.object({
  deviceId: z.string().uuid(),
  challengeId: z.string().uuid(),
  signature: z.string().min(1, "signature is required").max(256),
});

export const pushSubscriptionBodySchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(128),
  }),
});

export const pushUnsubscribeBodySchema = z.object({
  endpoint: z.string().url().max(2048),
});

export const markReadBodySchema = z.object({
  messageId: z.string().uuid(),
});

export const listMessagesQuerySchema = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** `1` 이면 고정된 메시지만 최신순으로 조회한다. */
  pinned: z.literal("1").optional(),
});

export const pinMessageBodySchema = z.object({
  pinned: z.boolean(),
});

export const searchUsersQuerySchema = z.object({
  username: z.string().trim().min(1).max(32),
});

export const conversationIdParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

export const messageIdParamsSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
});

/** 나에게만 삭제(me) 또는 모두에게서 삭제(all). 기본값은 기존 동작(all). */
export const deleteMessageQuerySchema = z.object({
  scope: z.enum(["me", "all"]).default("all"),
});

/** 대화별 자동 삭제(읽은 뒤 N초). null 이면 끔. 1시간~30일. */
export const updateAutoDeleteBodySchema = z.object({
  seconds: z.number().int().min(3600).max(30 * 24 * 60 * 60).nullable(),
});

/** 화면 테마. accent 는 프리셋 ID 또는 소문자 #rrggbb. */
export const themeAccentSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (value) =>
      ["violet", "blue", "emerald", "rose", "amber"].includes(value) ||
      /^#[0-9a-f]{6}$/.test(value),
    "accent must be a preset id or #rrggbb",
  );

export const updateThemeBodySchema = z.object({
  mode: z.enum(["light", "dark", "system"]),
  accent: themeAccentSchema,
});

/** 공개 프로필 상태 메시지(최대 80자). 빈 문자열은 null 로 정규화한다. */
export const updateProfileBodySchema = z.object({
  statusMessage: z
    .string()
    .trim()
    .max(80)
    .nullable()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

export const contactUserIdParamsSchema = z.object({
  userId: z.string().uuid(),
});

/** 마지막 접속 시각 공개 여부(옵트인). */
export const updateLastSeenBodySchema = z.object({
  visible: z.boolean(),
});

/** 공개 프로필 아바타 업로드. base64(패딩 없이 허용) + 허용 MIME 만 받는다. */
export const AVATAR_MAX_BASE64_LENGTH = 88 * 1024;
export const AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export const updateAvatarBodySchema = z.object({
  mime: z.enum(AVATAR_MIME_TYPES),
  data: z
    .string()
    .min(16)
    .max(AVATAR_MAX_BASE64_LENGTH)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "data must be base64"),
});

export const updateFavoriteBodySchema = z.object({
  favorite: z.boolean(),
});

export const updateBlockBodySchema = z.object({
  blocked: z.boolean(),
});

export const adminUserListQuerySchema = z.object({
  query: z.string().trim().max(32).optional(),
  cursor: z.string().trim().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const adminUserIdParamsSchema = z.object({
  userId: z.string().uuid(),
});

export const adminAuthEventsQuerySchema = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const adminDeviceListQuerySchema = z.object({
  query: z.string().trim().max(32).optional(),
  status: z.enum(["active", "revoked", "all"]).default("active"),
  cursor: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const adminDeviceParamsSchema = z.object({
  deviceId: z.string().uuid(),
});

export const decoyCreateBodySchema = z.object({
  alias: usernameSchema,
  handle: usernameSchema.optional(),
  password: passwordSchema,
});

export const decoyProfileParamsSchema = z.object({
  profileId: z.string().uuid(),
});

export const decoyPasswordBodySchema = z.object({
  password: passwordSchema,
});

export const decoyDisabledBodySchema = z.object({
  disabled: z.boolean(),
});

export const attachmentIdParamsSchema = z.object({
  attachmentId: z.string().uuid(),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

/** 일기장: 생성·대상 변경·글 작성. */
export const createDiaryBodySchema = z.object({
  label: z.string().trim().max(40).optional(),
  audienceUserIds: z.array(z.string().uuid()).max(20).default([]),
});
export const updateDiaryAudienceBodySchema = z.object({
  audienceUserIds: z.array(z.string().uuid()).max(20),
});
export const diaryIdParamsSchema = z.object({ diaryId: z.string().uuid() });
export const renameDiaryBodySchema = z.object({ label: z.string().trim().max(40).optional() });
export const diaryEntryParamsSchema = z.object({ entryId: z.string().uuid() });
export const diaryVersionParamsSchema = z.object({
  entryId: z.string().uuid(),
  versionId: z.string().uuid(),
});
export const diaryAttachmentParamsSchema = z.object({ attachmentId: z.string().uuid() });
export const diaryListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export const updateDiaryEntryBodySchema = z.object({
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
  signature: z.string().min(1),
  keys: z.array(z.unknown()).min(1),
});

export const createDiaryEntryBodySchema = z.object({
  clientEntryId: z.string().uuid(),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
  signature: z.string().min(1),
  keys: z.array(z.unknown()).min(1),
});
