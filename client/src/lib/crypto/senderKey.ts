import {
  aesDecrypt,
  aesEncrypt,
  deriveKek,
  deriveShared,
  importContentKey,
  randomBytes,
  signPayload,
  signaturePayload,
  subtle,
  verifyPayload,
  type DeviceIdentity,
} from "./keys.ts";
import { decoder, encoder, fromBase64, toBase64 } from "./encoding.ts";
import { withCryptoLock } from "./lock.ts";
import { padPlaintext, unpadPlaintext } from "./padding.ts";
import {
  findHistoryKey,
  rememberHistoryKey,
  unwrapContentKey,
  wrapContentKey,
} from "./ratchet.ts";
import { loadSenderKey, listSenderKeys, saveSenderKey } from "../keystore.ts";
import type { DeviceKeyEnvelope } from "./envelope.ts";

const SESSION_VERSION = 1 as const;
const MAX_SKIP = 1_000;

export class SenderKeyError extends Error {
  constructor(readonly reason: "key" | "state" | "signature") {
    super(`Sender key error: ${reason}`);
    this.name = "SenderKeyError";
  }
}

export interface SenderKeySession {
  version: typeof SESSION_VERSION;
  storageKey: string;
  mode: "send" | "recv";
  conversationId: string;
  localDeviceId: string;
  senderDeviceId: string;
  senderKeyId: string;
  chainKey: string;
  iteration: number;
  distributedDeviceIds: string[];
  skipped: Record<string, string>;
  memberCount?: number;
}

export interface SenderKeyDistribution {
  v: 1;
  kind: "sender-key";
  conversationId: string;
  senderKeyId: string;
  chainKey: string;
  iteration: number;
}

export interface SenderKeyPayload {
  clientMessageId: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  senderKeyId: string;
  senderKeyIteration: number;
  keys: DeviceKeyEnvelope[];
}

export interface PreparedSenderKeyMessage {
  payload: SenderKeyPayload;
  nextSession: SenderKeySession;
  messageKey: string;
}

export interface SenderKeyDevice {
  deviceId: string;
  identityPublicKey: string;
  signedPreKeyId?: string | null;
  signedPreKeyPublicKey?: string | null;
  oneTimePreKeyId?: string | null;
  oneTimePreKeyPublicKey?: string | null;
}

function storageKey(
  mode: "send" | "recv",
  conversationId: string,
  senderDeviceId: string,
  senderKeyId: string,
): string {
  return `${mode}:${conversationId}:${senderDeviceId}:${senderKeyId}`;
}

async function hmac(
  key: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await subtle().importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle().sign("HMAC", cryptoKey, data));
}

async function kdfChain(
  chainKey: Uint8Array<ArrayBuffer>,
): Promise<{ messageKey: Uint8Array<ArrayBuffer>; nextChainKey: Uint8Array<ArrayBuffer> }> {
  return {
    messageKey: await hmac(chainKey, new Uint8Array([1])),
    nextChainKey: await hmac(chainKey, new Uint8Array([2])),
  };
}

function senderLockKey(conversationId: string, deviceId: string): string {
  return `sender:${conversationId}:${deviceId}`;
}

async function loadSendSession(
  localDeviceId: string,
  conversationId: string,
): Promise<SenderKeySession | null> {
  const sessions = await listSenderKeys(localDeviceId);
  return (
    sessions.find(
      (session) =>
        session.mode === "send" &&
        session.conversationId === conversationId &&
        session.localDeviceId === localDeviceId,
    ) ?? null
  );
}

function createSendSession(
  identity: DeviceIdentity,
  conversationId: string,
  memberCount?: number,
): SenderKeySession {
  const localDeviceId = identity.deviceId ?? "local";
  const senderKeyId = crypto.randomUUID();
  return {
    version: SESSION_VERSION,
    storageKey: storageKey("send", conversationId, localDeviceId, senderKeyId),
    mode: "send",
    conversationId,
    localDeviceId,
    senderDeviceId: localDeviceId,
    senderKeyId,
    chainKey: toBase64(randomBytes(32)),
    iteration: 0,
    distributedDeviceIds: [localDeviceId],
    skipped: {},
    ...(memberCount === undefined ? {} : { memberCount }),
  };
}

/**
 * 그룹 메시지 1건을 sender key 로 암호화한다.
 * 새 기기에는 현재 체인 상태를 pairwise 봉투로 배포한다(최초 1회).
 */
export async function prepareSenderKeyMessage(input: {
  identity: DeviceIdentity;
  conversationId: string;
  clientMessageId: string;
  plaintext: string;
  devices: SenderKeyDevice[];
  memberCount?: number;
}): Promise<PreparedSenderKeyMessage> {
  const localDeviceId = input.identity.deviceId ?? "local";
  return withCryptoLock(senderLockKey(input.conversationId, localDeviceId), async () => {
    let session = await loadSendSession(localDeviceId, input.conversationId);
    if (
      !session ||
      (input.memberCount !== undefined && session.memberCount !== input.memberCount)
    ) {
      session = createSendSession(input.identity, input.conversationId, input.memberCount);
    }

    const distributed = new Set(session.distributedDeviceIds);
    const missing = input.devices.filter(
      (device) => device.deviceId !== localDeviceId && !distributed.has(device.deviceId),
    );

    const keys: DeviceKeyEnvelope[] = [];
    if (missing.length > 0) {
      const distribution: SenderKeyDistribution = {
        v: 1,
        kind: "sender-key",
        conversationId: input.conversationId,
        senderKeyId: session.senderKeyId,
        chainKey: session.chainKey,
        iteration: session.iteration,
      };
      const distributionContentKey = randomBytes(32);
      const distributionNonce = randomBytes(12);
      const distributionCiphertext = await aesEncrypt(
        await importContentKey(distributionContentKey),
        distributionNonce,
        encoder.encode(JSON.stringify(distribution)),
      );
      const distributionFields = {
        ciphertext: toBase64(distributionCiphertext),
        nonce: toBase64(distributionNonce),
      };

      for (const device of missing) {
        const wrapped = await wrapContentKey({
          identity: input.identity,
          conversationId: input.conversationId,
          remoteDeviceId: device.deviceId,
          remoteIdentityPublicKey: device.identityPublicKey,
          remoteSignedPreKeyId: device.signedPreKeyId,
          remoteSignedPreKeyPublicKey: device.signedPreKeyPublicKey,
          remoteOneTimePreKeyId: device.oneTimePreKeyId,
          remoteOneTimePreKeyPublicKey: device.oneTimePreKeyPublicKey,
          contentKey: distributionContentKey,
        });
        keys.push({
          deviceId: device.deviceId,
          ...wrapped,
          distribution: distributionFields,
        });
      }
    }

    const chainKey = fromBase64(session.chainKey);
    const { messageKey, nextChainKey } = await kdfChain(chainKey);
    const nonce = randomBytes(12);
    const ciphertext = await aesEncrypt(
      await importContentKey(messageKey),
      nonce,
      encoder.encode(padPlaintext(input.plaintext)),
    );
    const ciphertextBase64 = toBase64(ciphertext);
    const signature = await signPayload(
      input.identity.backend,
      input.identity.signingPrivate,
      await signaturePayload(
        input.conversationId,
        input.clientMessageId,
        ciphertextBase64,
      ),
    );

    const nextSession: SenderKeySession = {
      ...session,
      chainKey: toBase64(nextChainKey),
      iteration: session.iteration + 1,
      distributedDeviceIds: [
        ...new Set([...session.distributedDeviceIds, ...missing.map((d) => d.deviceId)]),
      ],
    };

    return {
      payload: {
        clientMessageId: input.clientMessageId,
        ciphertext: ciphertextBase64,
        nonce: toBase64(nonce),
        signature: toBase64(signature),
        senderKeyId: session.senderKeyId,
        senderKeyIteration: session.iteration,
        keys,
      },
      nextSession,
      messageKey: toBase64(messageKey),
    };
  });
}

export async function commitSenderKeyMessage(
  prepared: PreparedSenderKeyMessage,
): Promise<void> {
  await saveSenderKey(prepared.nextSession);
}


export interface SenderKeyDecryptableMessage {
  id?: string;
  conversationId: string;
  clientMessageId: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  senderDeviceId?: string;
  senderSigningPublicKey: string;
  senderKeyId: string;
  senderKeyIteration: number;
  key: DeviceKeyEnvelope | null;
}

async function unwrapDistribution(
  identity: DeviceIdentity,
  message: SenderKeyDecryptableMessage,
): Promise<SenderKeyDistribution> {
  const key = message.key;
  if (!key?.distribution) throw new SenderKeyError("key");

  let contentKey: Uint8Array<ArrayBuffer>;
  try {
    if (key.version === 2) {
      const result = await unwrapContentKey({
        identity,
        conversationId: message.conversationId,
        senderDeviceId: message.senderDeviceId ?? "unknown",
        header: {
          ratchetPublicKey: key.ratchetPublicKey,
          previousChainLength: key.previousChainLength,
          messageNumber: key.messageNumber,
          ...(key.senderIdentityPublicKey && key.signedPreKeyId
            ? {
                senderIdentityPublicKey: key.senderIdentityPublicKey,
                signedPreKeyId: key.signedPreKeyId,
                ...(key.oneTimePreKeyId
                  ? { oneTimePreKeyId: key.oneTimePreKeyId }
                  : {}),
              }
            : {}),
        },
        wrappedKey: key.wrappedKey,
        wrapNonce: key.wrapNonce,
      });
      contentKey = result.contentKey;
    } else {
      const shared = await deriveShared(
        identity.backend,
        identity.identityPrivate,
        key.ephemeralPublicKey,
      );
      const kek = await deriveKek(shared);
      contentKey = await aesDecrypt(
        kek,
        fromBase64(key.wrapNonce),
        fromBase64(key.wrappedKey),
      );
    }
    const plaintext = await aesDecrypt(
      await importContentKey(contentKey),
      fromBase64(key.distribution.nonce),
      fromBase64(key.distribution.ciphertext),
    );
    const parsed = JSON.parse(decoder.decode(plaintext)) as Partial<SenderKeyDistribution>;
    if (
      parsed.v !== 1 ||
      parsed.kind !== "sender-key" ||
      parsed.conversationId !== message.conversationId ||
      parsed.senderKeyId !== message.senderKeyId ||
      typeof parsed.chainKey !== "string" ||
      fromBase64(parsed.chainKey).length !== 32 ||
      typeof parsed.iteration !== "number" ||
      !Number.isInteger(parsed.iteration) ||
      parsed.iteration < 0
    ) {
      throw new SenderKeyError("state");
    }
    return parsed as SenderKeyDistribution;
  } catch (error) {
    if (error instanceof SenderKeyError) throw error;
    throw new SenderKeyError("key");
  }
}

async function deriveMessageKey(
  session: SenderKeySession,
  target: number,
): Promise<string> {
  const skipped = session.skipped[String(target)];
  if (skipped) {
    delete session.skipped[String(target)];
    return skipped;
  }
  if (target < session.iteration) throw new SenderKeyError("key");
  if (target - session.iteration > MAX_SKIP) throw new SenderKeyError("state");

  let chain = fromBase64(session.chainKey);
  while (session.iteration < target) {
    const { messageKey, nextChainKey } = await kdfChain(chain);
    session.skipped[String(session.iteration)] = toBase64(messageKey);
    chain = nextChainKey;
    session.iteration += 1;
  }
  const { messageKey, nextChainKey } = await kdfChain(chain);
  session.chainKey = toBase64(nextChainKey);
  session.iteration += 1;
  return toBase64(messageKey);
}

export async function decryptSenderKeyMessage(input: {
  identity: DeviceIdentity;
  message: SenderKeyDecryptableMessage;
}): Promise<string> {
  const { identity, message } = input;
  const verified = await verifyPayload(
    identity.backend,
    message.senderSigningPublicKey,
    await signaturePayload(
      message.conversationId,
      message.clientMessageId,
      message.ciphertext,
    ),
    fromBase64(message.signature),
  );
  if (!verified) throw new SenderKeyError("signature");

  const historyKey = await findHistoryKey(identity.deviceId, message.id);
  if (historyKey) {
    try {
      const plaintext = await aesDecrypt(
        await importContentKey(fromBase64(historyKey)),
        fromBase64(message.nonce),
        fromBase64(message.ciphertext),
      );
      return unpadPlaintext(decoder.decode(plaintext));
    } catch {
      throw new SenderKeyError("key");
    }
  }

  const localDeviceId = identity.deviceId ?? "local";
  const senderDeviceId = message.senderDeviceId ?? "unknown";
  const receiveStorageKey = storageKey(
    "recv",
    message.conversationId,
    senderDeviceId,
    message.senderKeyId,
  );
  let session = await loadSenderKey(receiveStorageKey);

  // 새로고침 직후에는 배포 메시지의 복호화가 늦게 끝날 수 있어 잠시 기다린다.
  if (!session && !message.key?.distribution) {
    for (let attempt = 0; attempt < 40 && !session; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      session = await loadSenderKey(receiveStorageKey);
    }
  }
  if (!session && !message.key?.distribution) throw new SenderKeyError("key");

  if (!session) {
    const distribution = await unwrapDistribution(identity, message);
    session = {
      version: SESSION_VERSION,
      storageKey: receiveStorageKey,
      mode: "recv",
      conversationId: message.conversationId,
      localDeviceId,
      senderDeviceId,
      senderKeyId: message.senderKeyId,
      chainKey: distribution.chainKey,
      iteration: distribution.iteration,
      distributedDeviceIds: [],
      skipped: {},
    };
  }

  const messageKey = await deriveMessageKey(session, message.senderKeyIteration);
  const plaintext = await aesDecrypt(
    await importContentKey(fromBase64(messageKey)),
    fromBase64(message.nonce),
    fromBase64(message.ciphertext),
  );
  await saveSenderKey(session);
  await rememberHistoryKey({
    deviceId: identity.deviceId,
    messageId: message.id,
    messageKey,
  });
  return unpadPlaintext(decoder.decode(plaintext));
}

