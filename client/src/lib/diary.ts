import { decryptMessage, encryptMessage, type StoredIdentity } from "./crypto/index.ts";

/**
 * 일기장 암호화/복호화.
 *
 * 메시지와 **같은 봉투 경로**를 쓴다: 글 1건마다 콘텐츠 키를 만들고, 참여자 활성 기기별로 봉투를 만든다.
 * 그래서 대상이 바뀌면 새 글이 새 봉투 집합을 갖고, 새로 추가된 사람의 기기에는
 * 과거 글 봉투가 없으므로 구조적으로 열 수 없다(정책 B).
 */

export interface DiaryRecipientDevice {
  id: string;
  identityPublicKey: string;
  signedPreKeyId: string | null;
  signedPreKeyPublicKey: string | null;
  signedPreKeySignature: string | null;
  oneTimePreKeyId: string | null;
  oneTimePreKeyPublicKey: string | null;
}

export interface DiaryEntryKey {
  deviceId: string;
  ephemeralPublicKey: string | null;
  ratchetPublicKey: string | null;
  previousChainLength: number | null;
  messageNumber: number | null;
  senderIdentityPublicKey: string | null;
  signedPreKeyId: string | null;
  oneTimePreKeyId: string | null;
  wrappedKey: string;
  wrapNonce: string;
  version: number;
}

export interface DiaryEntryCiphertext {
  diaryId: string;
  id: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  authorSigningPublicKey: string;
  keys: DiaryEntryKey[];
}

/** 에디터 HTML 을 암호화하고 대상 기기 봉투를 만든다(복호화는 작성자 기기에서 가능). */
export async function encryptDiaryEntry(input: {
  identity: StoredIdentity;
  diaryId: string;
  html: string;
  devices: DiaryRecipientDevice[];
  clientEntryId?: string;
}): Promise<{
  clientEntryId: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  keys: DiaryEntryKey[];
}> {
  const deduped = [
    ...new Map(input.devices.filter((device) => device.identityPublicKey.length > 0).map((device) => [device.id, device])).values(),
  ];
  if (deduped.length === 0) {
    throw new Error("공유할 기기가 없습니다. 대상자의 기기 등록을 확인해 주세요.");
  }
  // 서버 봉투 상한(기본 50)을 넘지 않도록 기기 수를 제한한다.
  const devices = deduped.slice(0, 40);
  const clientEntryId = input.clientEntryId ?? crypto.randomUUID();
  const payload = await encryptMessage({
    identity: input.identity,
    conversationId: input.diaryId,
    clientMessageId: clientEntryId,
    plaintext: input.html,
    recipients: devices.map((device) => ({
      deviceId: device.id,
      identityPublicKey: device.identityPublicKey,
      signedPreKeyId: device.signedPreKeyId,
      signedPreKeyPublicKey: device.signedPreKeyPublicKey,
      signedPreKeySignature: device.signedPreKeySignature,
      oneTimePreKeyId: device.oneTimePreKeyId,
      oneTimePreKeyPublicKey: device.oneTimePreKeyPublicKey,
    })),
  });
  return {
    clientEntryId,
    ciphertext: payload.ciphertext,
    nonce: payload.nonce,
    signature: payload.signature,
    keys: payload.keys as unknown as DiaryEntryKey[],
  };
}

/** 글 1건을 내 기기 봉투로 복호화한다(HTML). 봉투가 없으면 열 수 없다. */
export async function decryptDiaryEntry(
  identity: StoredIdentity,
  entry: DiaryEntryCiphertext,
): Promise<string> {
  const key =
    entry.keys.find((candidate) => candidate.deviceId === identity.deviceId) ?? entry.keys[0];
  if (!key) throw new Error("이 기기에서는 이 글을 열 수 없습니다.");
  return decryptMessage({
    identity,
    message: {
      conversationId: entry.diaryId,
      clientMessageId: entry.id,
      ciphertext: entry.ciphertext,
      nonce: entry.nonce,
      signature: entry.signature,
      senderSigningPublicKey: entry.authorSigningPublicKey,
      key: key as never,
    },
  });
}
