import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { attachments, type AttachmentRow } from "../db/schema.js";

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

export interface CreateAttachmentInput {
  conversationId: string;
  uploaderUserId: string;
  directory: string;
  data: Buffer;
}

export async function createAttachment(
  db: Database,
  input: CreateAttachmentInput,
): Promise<AttachmentRow> {
  const id = randomUUID();
  await saveAttachmentBlob(input.directory, id, input.data);
  try {
    const [row] = await db
      .insert(attachments)
      .values({
        id,
        conversationId: input.conversationId,
        uploaderUserId: input.uploaderUserId,
        size: input.data.byteLength,
      })
      .returning();
    if (!row) throw new Error("Failed to insert attachment");
    return row;
  } catch (error) {
    await removeAttachmentBlob(input.directory, id);
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
