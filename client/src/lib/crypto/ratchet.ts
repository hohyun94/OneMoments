import {
  aesDecrypt,
  aesEncrypt,
  deriveSharedSerialized,
  generateEphemeral,
  importContentKey,
  randomBytes,
  serializeX25519Private,
  subtle,
  type DeviceIdentity,
} from "./keys.ts";
import { encoder, fromBase64, toBase64, toBytes } from "./encoding.ts";
import {
  importHistoryKeys,
  importRatchetSessions,
  listHistoryKeys,
  listRatchetSessions,
  loadHistoryKey,
  loadRatchetSession,
  saveHistoryKey,
  saveRatchetSession,
} from "../keystore.ts";

export const RATCHET_VERSION = 2 as const;
const SESSION_VERSION = 1 as const;
const MAX_SKIP = 1_000;
const ZERO_ROOT = new Uint8Array(new ArrayBuffer(32));
const ROOT_INFO = encoder.encode("onemoments/dr/root-v1");

export type RatchetFailure = "key" | "state";

export class RatchetError extends Error {
  constructor(readonly reason: RatchetFailure) {
    super(`Ratchet error: ${reason}`);
    this.name = "RatchetError";
  }
}

export interface RatchetHeader {
  ratchetPublicKey: string;
  previousChainLength: number;
  messageNumber: number;
}

export interface RatchetSession {
  version: typeof SESSION_VERSION;
  conversationId: string;
  localDeviceId: string;
  remoteDeviceId: string;
  /** X25519 private(pkcs8 또는 noble raw) base64 */
  dhSelfPrivate: string;
  dhSelfPublic: string;
  dhRemote: string;
  rootKey: string;
  sendChainKey: string | null;
  recvChainKey: string | null;
  sendCount: number;
  recvCount: number;
  previousSendCount: number;
  /** `${ratchetPublicKey}:${messageNumber}` → message key base64 */
  skipped: Record<string, string>;
}

export interface WrappedContentKey extends RatchetHeader {
  version: typeof RATCHET_VERSION;
  wrappedKey: string;
  wrapNonce: string;
}

export interface HistoryKeyRecord {
  deviceId: string;
  messageId: string;
  /** AES-256 message key base64 */
  key: string;
  savedAt: number;
}

export interface LocalCryptoState {
  sessions: RatchetSession[];
  historyKeys: HistoryKeyRecord[];
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

async function kdfRoot(
  rootKey: Uint8Array<ArrayBuffer>,
  shared: Uint8Array<ArrayBuffer>,
): Promise<{ rootKey: Uint8Array<ArrayBuffer>; chainKey: Uint8Array<ArrayBuffer> }> {
  const material = await subtle().importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: rootKey, info: ROOT_INFO },
    material,
    512,
  );
  const output = new Uint8Array(bits);
  return {
    rootKey: toBytes(output.slice(0, 32)),
    chainKey: toBytes(output.slice(32, 64)),
  };
}

async function kdfChain(
  chainKey: Uint8Array<ArrayBuffer>,
): Promise<{ messageKey: Uint8Array<ArrayBuffer>; nextChainKey: Uint8Array<ArrayBuffer> }> {
  const messageKey = await hmac(chainKey, new Uint8Array([1]));
  const nextChainKey = await hmac(chainKey, new Uint8Array([2]));
  return { messageKey, nextChainKey };
}

async function dh(
  identity: DeviceIdentity,
  privateKeySerialized: string,
  publicKey: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return deriveSharedSerialized(identity.backend, privateKeySerialized, publicKey);
}

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  locks.set(key, next);
  return next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  });
}

function localDeviceId(identity: DeviceIdentity): string {
  return identity.deviceId ?? "local";
}

async function createInitiatorSession(
  identity: DeviceIdentity,
  conversationId: string,
  remoteDeviceId: string,
  remoteIdentityPublicKey: string,
): Promise<RatchetSession> {
  const ephemeral = await generateEphemeral(identity.backend);
  const dhSelfPrivate = await serializeX25519Private(identity.backend, ephemeral.privateKey);
  const shared = await dh(identity, dhSelfPrivate, remoteIdentityPublicKey);
  const root = await kdfRoot(ZERO_ROOT, shared);
  return {
    version: SESSION_VERSION,
    conversationId,
    localDeviceId: localDeviceId(identity),
    remoteDeviceId,
    dhSelfPrivate,
    dhSelfPublic: ephemeral.publicKey,
    dhRemote: remoteIdentityPublicKey,
    rootKey: toBase64(root.rootKey),
    sendChainKey: toBase64(root.chainKey),
    recvChainKey: null,
    sendCount: 0,
    recvCount: 0,
    previousSendCount: 0,
    skipped: {},
  };
}

async function createResponderSession(
  identity: DeviceIdentity,
  conversationId: string,
  senderDeviceId: string,
  header: RatchetHeader,
): Promise<RatchetSession> {
  const dhSelfPrivate = await serializeX25519Private(identity.backend, identity.identityPrivate);
  const shared = await dh(identity, dhSelfPrivate, header.ratchetPublicKey);
  const root = await kdfRoot(ZERO_ROOT, shared);
  return {
    version: SESSION_VERSION,
    conversationId,
    localDeviceId: localDeviceId(identity),
    remoteDeviceId: senderDeviceId,
    dhSelfPrivate,
    dhSelfPublic: identity.identityPublicKey,
    dhRemote: header.ratchetPublicKey,
    rootKey: toBase64(root.rootKey),
    sendChainKey: null,
    recvChainKey: toBase64(root.chainKey),
    sendCount: 0,
    recvCount: 0,
    previousSendCount: 0,
    skipped: {},
  };
}

async function advanceSendRatchet(
  identity: DeviceIdentity,
  session: RatchetSession,
): Promise<RatchetSession> {
  const ephemeral = await generateEphemeral(identity.backend);
  const dhSelfPrivate = await serializeX25519Private(identity.backend, ephemeral.privateKey);
  const shared = await dh(identity, dhSelfPrivate, session.dhRemote);
  const root = await kdfRoot(fromBase64(session.rootKey), shared);
  return {
    ...session,
    dhSelfPrivate,
    dhSelfPublic: ephemeral.publicKey,
    rootKey: toBase64(root.rootKey),
    sendChainKey: toBase64(root.chainKey),
    previousSendCount: session.sendCount,
    sendCount: 0,
  };
}

function sessionLockKey(conversationId: string, remoteDeviceId: string): string {
  return `${conversationId}:${remoteDeviceId}`;
}


/**
 * Double Ratchet 송신: 세션이 없으면 정적 상대 키로 초기화하고,
 * 상대 체인이 없으면 새 DH ratchet 키로 체인을 시작한다.
 * 반환된 헤더와 봉투는 서버에 그대로 저장된다(서버는 해석하지 않음).
 */
export async function wrapContentKey(input: {
  identity: DeviceIdentity;
  conversationId: string;
  remoteDeviceId: string;
  remoteIdentityPublicKey: string;
  contentKey: Uint8Array<ArrayBuffer>;
}): Promise<WrappedContentKey> {
  return withLock(
    sessionLockKey(input.conversationId, input.remoteDeviceId),
    async () => {
      let session = await loadRatchetSession(input.conversationId, input.remoteDeviceId);
      if (!session) {
        session = await createInitiatorSession(
          input.identity,
          input.conversationId,
          input.remoteDeviceId,
          input.remoteIdentityPublicKey,
        );
      }
      if (!session.sendChainKey) {
        session = await advanceSendRatchet(input.identity, session);
      }
      const sendChainKey = session.sendChainKey;
      if (!sendChainKey) throw new RatchetError("state");

      const { messageKey, nextChainKey } = await kdfChain(fromBase64(sendChainKey));
      const messageNumber = session.sendCount;
      const nonce = randomBytes(12);
      const wrappingKey = await importContentKey(messageKey);
      const wrapped = await aesEncrypt(wrappingKey, nonce, input.contentKey);

      const nextSession: RatchetSession = {
        ...session,
        sendChainKey: toBase64(nextChainKey),
        sendCount: messageNumber + 1,
      };
      await saveRatchetSession(nextSession);

      return {
        version: RATCHET_VERSION,
        ratchetPublicKey: session.dhSelfPublic,
        previousChainLength: session.previousSendCount,
        messageNumber,
        wrappedKey: toBase64(wrapped),
        wrapNonce: toBase64(nonce),
      };
    },
  );
}


export async function unwrapContentKey(input: {
  identity: DeviceIdentity;
  conversationId: string;
  senderDeviceId: string;
  header: RatchetHeader;
  wrappedKey: string;
  wrapNonce: string;
}): Promise<{ contentKey: Uint8Array<ArrayBuffer>; messageKey: string }> {
  return withLock(
    sessionLockKey(input.conversationId, input.senderDeviceId),
    async () => {
      let session = await loadRatchetSession(input.conversationId, input.senderDeviceId);
      if (!session) {
        session = await createResponderSession(
          input.identity,
          input.conversationId,
          input.senderDeviceId,
          input.header,
        );
      }

      const next: RatchetSession = { ...session, skipped: { ...session.skipped } };
      const skippedKey = `${input.header.ratchetPublicKey}:${input.header.messageNumber}`;
      let messageKeyBase64 = next.skipped[skippedKey];

      if (messageKeyBase64) {
        delete next.skipped[skippedKey];
      } else {
        if (input.header.ratchetPublicKey !== next.dhRemote) {
          await skipMessageKeys(next, input.header.previousChainLength);
          const oldSendCount = next.sendCount;
          next.previousSendCount = oldSendCount;
          next.sendCount = 0;
          next.recvCount = 0;
          next.dhRemote = input.header.ratchetPublicKey;

          const recvShared = await dh(
            input.identity,
            next.dhSelfPrivate,
            input.header.ratchetPublicKey,
          );
          const recvRoot = await kdfRoot(fromBase64(next.rootKey), recvShared);
          next.rootKey = toBase64(recvRoot.rootKey);
          next.recvChainKey = toBase64(recvRoot.chainKey);

          const ephemeral = await generateEphemeral(input.identity.backend);
          const dhSelfPrivate = await serializeX25519Private(
            input.identity.backend,
            ephemeral.privateKey,
          );
          const sendShared = await dh(
            input.identity,
            dhSelfPrivate,
            input.header.ratchetPublicKey,
          );
          const sendRoot = await kdfRoot(fromBase64(next.rootKey), sendShared);
          next.dhSelfPrivate = dhSelfPrivate;
          next.dhSelfPublic = ephemeral.publicKey;
          next.rootKey = toBase64(sendRoot.rootKey);
          next.sendChainKey = toBase64(sendRoot.chainKey);
        }

        if (input.header.messageNumber < next.recvCount) {
          throw new RatchetError("key");
        }
        if (!next.recvChainKey) throw new RatchetError("state");

        await skipMessageKeys(next, input.header.messageNumber);
        const currentChain = fromBase64(next.recvChainKey);
        const { messageKey, nextChainKey } = await kdfChain(currentChain);
        messageKeyBase64 = toBase64(messageKey);
        next.recvChainKey = toBase64(nextChainKey);
        next.recvCount = input.header.messageNumber + 1;
      }

      const wrappingKey = await importContentKey(fromBase64(messageKeyBase64));
      const contentKey = await aesDecrypt(
        wrappingKey,
        fromBase64(input.wrapNonce),
        fromBase64(input.wrappedKey),
      );
      await saveRatchetSession(next);
      return { contentKey, messageKey: messageKeyBase64 };
    },
  );
}

async function skipMessageKeys(session: RatchetSession, until: number): Promise<void> {
  if (until < session.recvCount) return;
  if (until - session.recvCount > MAX_SKIP) {
    throw new RatchetError("state");
  }
  if (!session.recvChainKey) {
    if (until === session.recvCount) return;
    throw new RatchetError("state");
  }

  let chain = fromBase64(session.recvChainKey);
  while (session.recvCount < until) {
    const { messageKey, nextChainKey } = await kdfChain(chain);
    session.skipped[`${session.dhRemote}:${session.recvCount}`] = toBase64(messageKey);
    chain = nextChainKey;
    session.recvCount += 1;
  }
  session.recvChainKey = toBase64(chain);
}


export async function decryptWithMessageKey(input: {
  messageKey: string;
  wrappedKey: string;
  wrapNonce: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  const key = await importContentKey(fromBase64(input.messageKey));
  return aesDecrypt(key, fromBase64(input.wrapNonce), fromBase64(input.wrappedKey));
}

export async function findHistoryKey(
  deviceId: string | undefined,
  messageId: string | undefined,
): Promise<string | null> {
  if (!deviceId || !messageId) return null;
  return loadHistoryKey(deviceId, messageId);
}

export async function rememberHistoryKey(input: {
  deviceId: string | undefined;
  messageId: string | undefined;
  messageKey: string;
}): Promise<void> {
  if (!input.deviceId || !input.messageId) return;
  await saveHistoryKey({
    deviceId: input.deviceId,
    messageId: input.messageId,
    key: input.messageKey,
    savedAt: Date.now(),
  });
}

/** 키 백업에 포함할 로컬 DR 세션/이력 키(최근 5000건). */
export async function exportLocalCryptoState(localDevice: string): Promise<LocalCryptoState> {
  const [sessions, historyKeys] = await Promise.all([
    listRatchetSessions(localDevice),
    listHistoryKeys(localDevice),
  ]);
  const recent = [...historyKeys]
    .sort((left, right) => right.savedAt - left.savedAt)
    .slice(0, 5_000);
  return { sessions, historyKeys: recent };
}

/** 복구 시 백업에 포함된 DR 세션/이력 키를 복원한다. */
export async function importLocalCryptoState(state: LocalCryptoState): Promise<void> {
  await importRatchetSessions(state.sessions);
  await importHistoryKeys(state.historyKeys.slice(0, 5_000));
}

