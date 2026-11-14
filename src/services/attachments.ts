import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";

import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { attachments, type AttachmentRow } from "../db/schema.js";

const S3_KEY_PREFIX = "attachments";

export interface AttachmentStorage {
  put(attachmentId: string, data: Buffer): Promise<void>;
  get(attachmentId: string): Promise<Buffer>;
  delete(attachmentId: string): Promise<void>;
}

/** 파일은 UUID 이름으로만 저장한다(경로 조작 불가). 내용은 클라이언트가 암호화한 블롭이다. */
export function attachmentFilePath(directory: string, attachmentId: string): string {
  return path.join(path.resolve(directory), `${attachmentId}.bin`);
}

export async function saveAttachmentBlob(
  directory: string,
  attachmentId: string,
  data: Buffer,
): Promise<void> {
  await mkdir(path.resolve(directory), { recursive: true, mode: 0o700 });
  await writeFile(attachmentFilePath(directory, attachmentId), data, { mode: 0o600 });
}

export async function readAttachmentBlob(
  directory: string,
  attachmentId: string,
): Promise<Buffer> {
  return readFile(attachmentFilePath(directory, attachmentId));
}

export async function removeAttachmentBlob(
  directory: string,
  attachmentId: string,
): Promise<void> {
  await unlink(attachmentFilePath(directory, attachmentId)).catch(() => undefined);
}

function localAttachmentStorage(directory: string): AttachmentStorage {
  return {
    put: (id, data) => saveAttachmentBlob(directory, id, data),
    get: (id) => readAttachmentBlob(directory, id),
    delete: (id) => removeAttachmentBlob(directory, id),
  };
}

function s3AttachmentStorage(config: Config): AttachmentStorage {
  if (!config.s3Bucket) {
    throw new Error("S3_BUCKET is required when ATTACHMENT_STORAGE=s3");
  }
  const bucket = config.s3Bucket;
  const client = new S3Client({
    region: config.s3Region,
    ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
    ...(config.s3AccessKeyId && config.s3SecretAccessKey
      ? {
          credentials: {
            accessKeyId: config.s3AccessKeyId,
            secretAccessKey: config.s3SecretAccessKey,
          },
        }
      : {}),
    forcePathStyle: config.s3ForcePathStyle,
  });
  const key = (attachmentId: string) => `${S3_KEY_PREFIX}/${attachmentId}.bin`;
  return {
    async put(attachmentId, data) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key(attachmentId),
          Body: data,
          ContentType: "application/octet-stream",
        }),
      );
    },
    async get(attachmentId) {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key(attachmentId) }),
      );
      if (!response.Body) throw new Error("S3 object has no body");
      return Buffer.from(await response.Body.transformToByteArray());
    },
    async delete(attachmentId) {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key(attachmentId) }),
      );
    },
  };
}

export function createAttachmentStorage(config: Config): AttachmentStorage {
  return config.attachmentStorage === "s3"
    ? s3AttachmentStorage(config)
    : localAttachmentStorage(config.attachmentDir);
}

export interface CreateAttachmentInput {
  conversationId: string;
  uploaderUserId: string;
  messageClientId?: string | null;
  storage: AttachmentStorage;
  data: Buffer;
}

export async function createAttachment(
  db: Database,
  input: CreateAttachmentInput,
): Promise<AttachmentRow> {
  const id = randomUUID();
  await input.storage.put(id, input.data);
  try {
    const [row] = await db
      .insert(attachments)
      .values({
        id,
        conversationId: input.conversationId,
        uploaderUserId: input.uploaderUserId,
        messageClientId: input.messageClientId ?? null,
        size: input.data.byteLength,
      })
      .returning();
    if (!row) throw new Error("Failed to insert attachment");
    return row;
  } catch (error) {
    await input.storage.delete(id);
    throw error;
  }
}

export async function findAttachment(
  db: Database,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .limit(1);
  return row ?? null;
}

export async function markAttachmentAccessed(
  db: Database,
  attachmentId: string,
): Promise<void> {
  await db
    .update(attachments)
    .set({ lastAccessedAt: new Date() })
    .where(eq(attachments.id, attachmentId));
}

/** 메시지에 연결되지 않은 채 TTL이 지난 업로드만 삭제한다(구버전 첨부는 대상 아님). */
export async function cleanupOrphanAttachments(
  db: Database,
  storage: AttachmentStorage,
  olderThan: Date,
): Promise<number> {
  const rows = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        isNull(attachments.messageId),
        isNull(attachments.lastAccessedAt),
        lt(attachments.createdAt, olderThan),
        isNotNull(attachments.messageClientId),
      ),
    )
    .limit(500);
  let removed = 0;
  for (const row of rows) {
    await storage.delete(row.id);
    await db.delete(attachments).where(eq(attachments.id, row.id));
    removed += 1;
  }
  return removed;
}
