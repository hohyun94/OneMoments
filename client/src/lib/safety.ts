export interface SafetyDevice {
  userId: string;
  identityPublicKey: string;
  signingPublicKey: string;
}

export interface SafetyNumber {
  digits: string;
  groups: string[];
  hex: string;
}

const encoder = new TextEncoder();

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 두 사용자의 활성 기기 공개키로 안전번호를 만든다.
 * - 사용자별로 기기 키를 정렬·해시하고, 사용자 ID 순으로 정렬해 다시 해시한다.
 * - 양쪽 클라이언트가 같은 기기 목록을 받으면 같은 번호를 계산한다.
 * - 기기 추가/폐기로 키가 바뀌면 번호도 바뀐다.
 */
export async function computeSafetyNumber(
  devices: SafetyDevice[],
): Promise<SafetyNumber | null> {
  if (devices.length === 0) return null;

  const byUser = new Map<string, SafetyDevice[]>();
  for (const device of devices) {
    const list = byUser.get(device.userId) ?? [];
    list.push(device);
    byUser.set(device.userId, list);
  }
  const userIds = [...byUser.keys()].sort();
  if (userIds.length < 2) return null;

  const userDigests: Uint8Array<ArrayBuffer>[] = [];
  for (const userId of userIds) {
    const list = [...(byUser.get(userId) ?? [])].sort((left, right) => {
      const leftKey = `${left.identityPublicKey}:${left.signingPublicKey}`;
      const rightKey = `${right.identityPublicKey}:${right.signingPublicKey}`;
      return leftKey.localeCompare(rightKey);
    });
    const material = encoder.encode(
      [userId, ...list.map((device) => `${device.identityPublicKey}:${device.signingPublicKey}`)].join(
        "\n",
      ),
    );
    userDigests.push(await sha256(material));
  }

  const combined = new Uint8Array(
    userDigests.reduce((total, digest) => total + digest.length, 0),
  );
  let offset = 0;
  for (const digest of userDigests) {
    combined.set(digest, offset);
    offset += digest.length;
  }
  const final = await sha256(combined);

  const material = new Uint8Array(combined.length + final.length);
  material.set(combined);
  material.set(final, combined.length);

  let digits = "";
  for (let index = 0; index < 60; index += 1) {
    const byte = material[index % material.length] ?? 0;
    digits += (byte % 10).toString();
  }

  return {
    digits,
    groups: digits.match(/.{5}/g) ?? [],
    hex: toHex(final),
  };
}
